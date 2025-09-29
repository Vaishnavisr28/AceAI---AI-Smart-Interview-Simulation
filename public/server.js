require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const ejsMate = require('ejs-mate'); // Keeping, in case you use EJS later
const { GoogleGenerativeAI } = require('@google/generative-ai');


const app = express();
app.use(cors());
app.use(express.json());

// Set up ejs-mate as the view engine 
app.engine('ejs', ejsMate);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Google Generative AI
const genAI = new GoogleGenerativeAI(process.env.API_KEY);



// Default HR questions (used as a fallback or for generic interviews)
const hrQuestions = [
    "Tell me about yourself.",
    "Why should we hire you?",
    "What are your strengths and weaknesses?",
    "Where do you see yourself in 5 years?",
    "Why are you interested in this company?",
    "Describe a challenging situation you faced at work.",
    "What motivates you to do your best work?",
    "How do you handle stress and pressure?"
];

// --- Helper Functions ---

/**
 * Generates content using a set of preferred models with retry logic.
 * @param {string} prompt The text prompt to send to the model.
 * @param {number} retries The maximum number of retries per model.
 * @returns {Promise<string>} The raw text response from the model.
 */
async function generateQuestionsWithRetry(prompt, retries = 3) {
    const models = ["gemini-2.5-flash", "gemini-2.5-pro"];
    let lastError = null;

    for (const modelName of models) {
        const model = genAI.getGenerativeModel({ model: modelName });

        for (let i = 0; i < retries; i++) {
            try {
                const response = await model.generateContent(prompt);
                console.log('Gemini raw response:', JSON.stringify(response, null, 2));
                // FIX: Extract the text from the correct place
                const text = response?.response?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!text) throw new Error("No text found in Gemini response");
                return text;
            } catch (error) {
                lastError = error;
                console.warn(`Attempt ${i + 1} failed for ${modelName}. Retrying...`, error.message);
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
            }
        }
    }

    console.error("❌ All models failed after all retries.");
    throw new Error(`Failed to generate content: ${lastError.message}`);
}


// --- API Routes ---

// Route to generate a set of interview questions based on domain and level
app.post('/api/generate-questions', async (req, res) => {
    const { domain, level, numQuestions = 5 } = req.body;

    if (!domain || !level) {
        // Return HR questions if domain/level are missing
        return res.json({ questions: hrQuestions.slice(0, numQuestions) });
    }

    // Decide how many HR and technical questions you want
    const numHR = 2;
    const numTech = numQuestions - numHR;

    const prompt = `
Respond ONLY with a valid JSON array of exactly ${numTech} technical interview questions as strings.
Do NOT include any explanations, markdown, or extra text.
Example: ["Q1", "Q2", "Q3"]
Domain: ${domain}
Level: ${level}
`;

    try {
        const rawText = await generateQuestionsWithRetry(prompt, 3);

        // Try to extract JSON array
        const startIndex = rawText.indexOf('[');
        const endIndex = rawText.lastIndexOf(']');
        let techQuestions = [];
        if (startIndex !== -1 && endIndex !== -1) {
            const jsonString = rawText.substring(startIndex, endIndex + 1);
            techQuestions = JSON.parse(jsonString);
        } else {
            // Fallback: extract lines that look like questions
            const lines = rawText.split('\n').filter(line =>
                /^\d+\./.test(line.trim()) || /^[-*]\s/.test(line.trim())
            );
            techQuestions = lines.map(line => line.replace(/^\d+\.\s*|^[-*]\s*/, '').trim())
                .filter(q => q.length > 10);
        }

        // Mix HR and technical questions
        const selectedHR = hrQuestions.sort(() => 0.5 - Math.random()).slice(0, numHR);
        const allQuestions = [...selectedHR, ...techQuestions].slice(0, numQuestions);

        res.json({ questions: allQuestions });

    } catch (error) {
        console.error("Question generation failed:", error.message);
        res.status(500).json({
            error: 'Failed to generate specific questions. Serving generic questions.',
            questions: hrQuestions.slice(0, numQuestions)
        });
    }
});


// Route to evaluate the candidate's answer
app.post('/api/evaluate-answer', async (req, res) => {
    const { question, answer, domain, level } = req.body;

    if (!question || !answer) {
        return res.status(400).json({ error: 'Missing question or answer for evaluation.' });
    }

    const systemPrompt = `You are an expert interview evaluator. Analyze the candidate's answer based on the question, domain (${domain}), and target level (${level}). Your response must be ONLY a single JSON object with the following structure:
    {
      "score": "<integer from 1 to 5, where 5 is excellent>",
      "tip": "<A single, actionable suggestion for improvement. Keep it concise, e.g., 'Ensure you structure your response using STAR method.'>",
      "proficiency": "<A high-level proficiency assessment, e.g., 'Good grasp of fundamentals.', 'Excellent depth of knowledge.'>",
      "overallFeedback": "<A one-paragraph summary of the candidate's overall performance across all answers provided so far (if available in the context). If this is the only answer, summarize its strengths and weaknesses.>"
    }`;

    const userPrompt = `Evaluate the following response for a ${level} level interview question in the ${domain} domain:
    Question: "${question}"
    Candidate Answer: "${answer}"
    `;

    try {
        const rawText = await generateQuestionsWithRetry(userPrompt, 3);
        
        // Find the JSON object boundaries (might be enclosed in markdown ```json)
        const startIndex = rawText.indexOf('{');
        const endIndex = rawText.lastIndexOf('}');
        
        if (startIndex === -1 || endIndex === -1) {
            console.error("No JSON object found in model response. Response:", rawText);
            throw new Error("No JSON object found.");
        }

        const jsonString = rawText.substring(startIndex, endIndex + 1);

        const evaluationJson = JSON.parse(jsonString);
        res.json({ evaluation: evaluationJson });

    } catch (error) {
        console.error("Evaluation parsing failed:", error.message);
        res.status(500).json({ error: 'Failed to parse evaluation from model.' });
    }
});

// Route to evaluate the final set of answers
app.post('/api/final-evaluation', async (req, res) => {
    const { qaPairs, domain, level } = req.body;
    if (!qaPairs || !Array.isArray(qaPairs) || qaPairs.length === 0) {
        return res.status(400).json({ error: 'No answers provided.' });
    }

    const prompt = `
You are an expert interview evaluator. Given the following Q&A pairs for a ${level} ${domain} interview, provide a JSON object with:
{
  "overallScore": "<integer 1-5>",
  "overallFeedback": "<one-paragraph summary>",
  "strengths": "<short bullet list>",
  "areasForImprovement": "<short bullet list>"
}
Q&A pairs:
${qaPairs.map((qa, i) => `Q${i+1}: ${qa.question}\nA${i+1}: ${qa.answer}`).join('\n')}
`;

    try {
        const rawText = await generateQuestionsWithRetry(prompt, 3);
        const startIndex = rawText.indexOf('{');
        const endIndex = rawText.lastIndexOf('}');
        if (startIndex === -1 || endIndex === -1) {
            throw new Error("No JSON object found.");
        }
        const jsonString = rawText.substring(startIndex, endIndex + 1);
        const evaluationJson = JSON.parse(jsonString);
        res.json({ evaluation: evaluationJson });
    } catch (error) {
        console.error("Final evaluation parsing failed:", error.message);
        res.status(500).json({ error: 'Failed to parse final evaluation from model.' });
    }
});


// --- Static Page Routes (Serving HTML files from 'public') ---

// Goal 1: Root URL serves the home page (home_index.html)
app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'home_index.html'));
});

// Home page route (points to the same file)
app.get('/home', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'home_index.html'));
});

// About page
app.get('/about', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'about.html'));
});

// Main Interview page (Setup page is index.html)
app.get('/interview', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// Catch-all/Placeholder routes (redirect to home)
app.get('/profile', (req, res) => {
    res.redirect('/home');
});

app.get('/contact', (req, res) => {
    res.redirect('/home');
});




// --- Server Listener ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
