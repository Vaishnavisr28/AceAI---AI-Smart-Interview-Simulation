
///// CONFIG /////
const POSE_CHECK_MS = 900;         // pose frequency (ms)
const OBJECT_CHECK_MS = 1600;      // object detection freq (ms)
const POSTURE_BUFFER = 20;         // how many angle readings to average
const POSTURE_WARN_ANGLE = 20;     // avg angle > this => warning
const POSTURE_STRIKE_ANGLE = 30;   // avg angle > this => immediate violation
const REQUIRED_CONSECUTIVE_FRAMES = 3; // for posture strike
const MAX_WARNINGS = 2;            // warnings before strike per type
const MAX_STRIKES = 3;             // interview termination
const STRIKE_COOLDOWN_MS = 10000;  // per-reason cooldown so single event doesn't spam


///// STATE /////
let consecutiveBadPosture = 0;
let questions = [];
let currentIndex = 0;
let answers = [];
let recognition = null;
let questionTimerId = null;
let posenetNet = null;
let cocoModel = null;
let faceMeshModel = null; // optional

let videoElem = null;
let overlayCanvas = null;
let overlayCtx = null;

let poseIntervalId = null;
let objectIntervalId = null;

let postureAngles = []; // circular buffer
let violationCounters = { posture: 0, lookAway: 0, phone: 0, faceAbsent: 0 };
let strikes = 0;
let lastStrikeAt = {}; // reason => timestamp

///// DOM SHORTCUTS (safe-get) /////
const $ = id => document.getElementById(id);

function safeEl(id) { return document.getElementById(id) || null; }

///// UTILITIES /////
function now() { return Date.now(); }

function startQuestionTimer() {
    // Clear any existing timer
    if (questionTimerId) {
        clearTimeout(questionTimerId);
    }

    const durationSeconds = 60; // 1 minute
    let remainingSeconds = durationSeconds;
    const timerEl = safeEl('question-timer');
    
    // Create timer display if it doesn't exist (assuming you want one)
    if (!timerEl) {
        // You should add this element to your main interview HTML structure
        console.warn("DOM element with ID 'question-timer' not found. Timer will run but not display.");
    }
    
    function tick() {
        if (remainingSeconds < 0) {
            // Time is up! Automatically proceed to the next question.
            saveAnswerAndProceed();
            return;
        }

        const minutes = Math.floor(remainingSeconds / 60);
        const seconds = remainingSeconds % 60;
        const displayTime = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        
        if (timerEl) {
            timerEl.textContent = `Time Remaining: ${displayTime}`;
            timerEl.style.color = remainingSeconds <= 10 ? 'red' : 'green';
        }

        remainingSeconds--;

        // Schedule the next tick
        questionTimerId = setTimeout(tick, 1000);
    }
    
    // Start the timer
    tick();
}

function canStrike(reason) {
  const last = lastStrikeAt[reason] || 0;
  return (now() - last) > STRIKE_COOLDOWN_MS;
}
function markStrike(reason) { lastStrikeAt[reason] = now(); }

function showToast(msg) {
  let t = $('proctor-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'proctor-toast';
    t.style.position = 'fixed';
    t.style.right = '20px';
    t.style.top = '20px';
    t.style.background = 'rgba(0,0,0,0.78)';
    t.style.color = 'white';
    t.style.padding = '10px 14px';
    t.style.borderRadius = '8px';
    t.style.zIndex = 999999;
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(() => { if (t) t.style.opacity = '0'; }, 3500);
}

function updateStrikeUI() {
  const el = safeEl('strike-count');
  if (el) el.textContent = `${strikes}/${MAX_STRIKES}`;
}

function addStrike(reason) {
  if (!canStrike(reason)) return;
  strikes++;
  markStrike(reason);
  updateStrikeUI();
  showToast(`Rule violation: ${reason} (${strikes}/${MAX_STRIKES})`);
  if (strikes >= MAX_STRIKES) finishTerminate(reason);
}

function handleViolation(type, message) {
  violationCounters[type] = (violationCounters[type] || 0) + 1;
  if (violationCounters[type] <= MAX_WARNINGS) {
    updateProctoringUI('warning', 'Warning', `${message} (${violationCounters[type]}/${MAX_WARNINGS})`);
  } else {
    updateProctoringUI('poor', 'Violation', `${message} — strike given.`);
    // give strike for this violation
    addStrike(`${type} violation`);
    violationCounters[type] = 0;
  }
}

function updateProctoringUI(statusClass, statusText, recommendation) {
  const statusEl = safeEl('posture-status');
  const recEl = safeEl('posture-recommendation');
  if (statusEl) { statusEl.className = `posture-tag ${statusClass}`; statusEl.textContent = statusText; }
  if (recEl) { recEl.className = statusClass; recEl.textContent = recommendation; }
}

function finishTerminate(reason) {
  // stop loops & media, but keep page for button navigation
  try {
    if (poseIntervalId) clearInterval(poseIntervalId);
    if (objectIntervalId) clearInterval(objectIntervalId);
    if (videoElem && videoElem.srcObject) videoElem.srcObject.getTracks().forEach(t => t.stop());
  } catch (e) { console.warn(e); }

  // show termination overlay (non-blocking)
  const termBox = document.createElement('div');
  termBox.id = 'interruption-screen';
  termBox.style.position = 'fixed';
  termBox.style.inset = '0';
  termBox.style.background = 'rgba(0,0,0,0.85)';
  termBox.style.color = 'white';
  termBox.style.display = 'flex';
  termBox.style.flexDirection = 'column';
  termBox.style.justifyContent = 'center';
  termBox.style.alignItems = 'center';
  termBox.style.zIndex = 1000000;
  termBox.innerHTML = `
    <h1 style="margin:0 0 12px 0; color:#ff6b6b">Interview Terminated</h1>
    <p style="max-width:720px; text-align:center; margin-bottom:18px;">Session ended due to repeated violations: ${reason}. You can return to home.</p>
    <div style="display:flex; gap:12px;">
      <button id="term-home-btn" style="padding:10px 14px; font-size:16px; border-radius:8px; cursor:pointer">Go to Home</button>
      <button id="term-refresh-btn" style="padding:10px 14px; font-size:16px; border-radius:8px; cursor:pointer">Reload Page</button>
    </div>
  `;
  document.body.appendChild(termBox);
  $('term-home-btn').addEventListener('click', () => window.location.href = '/home_index.html');
  $('term-refresh-btn').addEventListener('click', () => window.location.reload());
}

///// MODEL LOADING /////
async function loadModelsWithFallback() {
  const loaderText = safeEl('loader-text');
  try {
    if (loaderText) loaderText.textContent = 'Loading PoseNet...';
    posenetNet = await posenet.load({ architecture: 'MobileNetV1', outputStride: 16, inputResolution: { width: 320, height: 240 }, multiplier: 0.75 });
  } catch (e) {
    console.error('PoseNet load failed', e);
    posenetNet = null;
  }

  try {
    if (loaderText) loaderText.textContent = 'Loading Coco SSD...';
    cocoModel = await cocoSsd.load();
  } catch (e) {
    console.warn('CocoSSD not available', e);
    cocoModel = null;
  }

  // FaceMesh is optional: only attempt load if facemesh is present in global scope
  try {
    if (window.facemesh) {
      if (loaderText) loaderText.textContent = 'Loading FaceMesh...';
      faceMeshModel = await facemesh.load();
    } else {
      faceMeshModel = null;
    }
  } catch (e) {
    console.warn('FaceMesh load failed or not present', e);
    faceMeshModel = null;
  }
}

///// VIDEO + CANVAS SETUP /////
function ensureVideoAndOverlay() {
  videoElem = safeEl('interview-video');
  if (!videoElem) {
    // create a video element if missing
    videoElem = document.createElement('video');
    videoElem.id = 'interview-video';
    videoElem.width = 640;
    videoElem.height = 480;
    videoElem.autoplay = true;
    videoElem.muted = true;
    videoElem.playsInline = true;
    videoElem.style.border = '2px solid #333';
    videoElem.style.borderRadius = '6px';
    document.body.prepend(videoElem);
  } else {
    videoElem.style.display = 'block';
  }

  overlayCanvas = safeEl('overlay-canvas');
  if (!overlayCanvas) {
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = 'overlay-canvas';
    overlayCanvas.width = videoElem.width;
    overlayCanvas.height = videoElem.height;
    overlayCanvas.style.position = 'absolute';
    overlayCanvas.style.left = videoElem.offsetLeft + 'px';
    overlayCanvas.style.top = videoElem.offsetTop + 'px';
    overlayCanvas.style.pointerEvents = 'none';
    overlayCanvas.style.zIndex = 99998;
    // place overlay after video in DOM
    videoElem.parentNode.insertBefore(overlayCanvas, videoElem.nextSibling);
  }
  overlayCtx = overlayCanvas.getContext('2d');

  // Resize overlay to match actual rendered video size
  function syncOverlaySize() {
    const rect = videoElem.getBoundingClientRect();
    overlayCanvas.style.left = rect.left + 'px';
    overlayCanvas.style.top = rect.top + 'px';
    overlayCanvas.width = rect.width;
    overlayCanvas.height = rect.height;
    overlayCanvas.style.width = rect.width + 'px';
    overlayCanvas.style.height = rect.height + 'px';
  }
  window.addEventListener('resize', syncOverlaySize);
  // call once after DOM paint
  setTimeout(syncOverlaySize, 200);
}


///// ANALYSIS LOGIC /////
function pushAngle(angle) {
  postureAngles.push(angle);
  if (postureAngles.length > POSTURE_BUFFER) postureAngles.shift();
}
function avgAngle() {
  if (postureAngles.length === 0) return 0;
  return postureAngles.reduce((a, b) => a + b, 0) / postureAngles.length;
}


// Helper to get midpoint of two keypoints
function getMidPoint(kp1, kp2) {
    if (!kp1 || !kp2) return null;
    return {
        position: {
            x: (kp1.position.x + kp2.position.x) / 2,
            y: (kp1.position.y + kp2.position.y) / 2,
        }
    };
}

// **New Robust Function:** Calculates the spine tilt angle (deviation from vertical)
function getSpineTiltAngle(shoulder, hip) {
    if (!shoulder || !hip) return 0;
    
    // Y-axis is inverted (0 at top). dy is Shoulder Y - Hip Y.
    const dy = shoulder.position.y - hip.position.y;
    const dx = shoulder.position.x - hip.position.x;

    // Angle relative to the horizontal axis (in radians)
    const angleRad = Math.atan2(dy, dx); 
    let degrees = angleRad * (180 / Math.PI);
    
    // Normalize to 0-180 for simpler deviation check
    if (degrees < 0) degrees += 180; 

    // Deviation from the ideal vertical (90 degrees)
    return Math.abs(degrees - 90); 
}

// Constant for minimum confidence for a keypoint to be used
const MIN_CONFIDENCE = 0.6; 
// Constant for minimum average pose score
const MIN_POSE_SCORE = 0.4;

async function analyzePose() {
    try {
        if (!posenetNet || !videoElem || videoElem.readyState < 2) {
            updateProctoringUI('warn', 'Awaiting Video', 'Camera feed not ready for pose analysis.');
            return;
        }

        // Estimate a single pose on the video frame
        const pose = await posenetNet.estimateSinglePose(videoElem, {
            flipHorizontal: false,
            decodingMethod: 'single-person',
            maxDetections: 1,
            scoreThreshold: MIN_POSE_SCORE,
            nmsRadius: 20
        });

        if (!pose || pose.score < 0.4 || !pose.keypoints) {
            // Not a confident pose detection
            updateProctoringUI('poor', 'Undetected', 'Ensure good lighting and full view of upper body.');
             violationCounters.posture = 0;
            return;
        }

        const keypoints = pose.keypoints.reduce((acc, kp) => { acc[kp.part] = kp; return acc; }, {});

        const leftShoulder = keypoints['leftShoulder'];
        const rightShoulder = keypoints['rightShoulder'];
        const leftHip = keypoints['leftHip'];
        const rightHip = keypoints['rightHip'];
        const nose = keypoints['nose'];

        if (!leftShoulder || !rightShoulder || !leftHip || !rightHip || !nose) {
            updateProctoringUI('poor', 'Undetected', 'Could not detect shoulders or hips.');
              consecutiveBadPosture = 0;
            return;
        }
        // 3. Calculate Spine Tilt
        const midShoulder = getMidPoint(leftShoulder, rightShoulder);
        const midHip = getMidPoint(leftHip, rightHip);
        
        // Calculate the spine tilt angle (deviation from vertical)
        const spineAngle = getSpineTiltAngle(midShoulder, midHip); 

        pushAngle(spineAngle);
        const currentAvgAngle = avgAngle();
        const angleDisplay = currentAvgAngle.toFixed(1);

        // 4. Posture Warning/Strike Logic
        if (currentAvgAngle > POSTURE_STRIKE_ANGLE) {
            // IMMEDIATE STRIKE CONDITION (Severe Slouch)
            consecutiveBadPosture++;
            updateProctoringUI('poor', 'Violation', `Severe slouch detected (Avg Angle: ${angleDisplay}°).`);
            if (consecutiveBadPosture >= REQUIRED_CONSECUTIVE_FRAMES) {
                addStrike('posture-severe');
                violationCounters.posture = 0; 
                consecutiveBadPosture = 0;
            }
        } else if (currentAvgAngle > POSTURE_WARN_ANGLE) {
            // WARNING CONDITION (Moderate Slouch)
            consecutiveBadPosture = 0; 
            handleViolation('posture', `Poor posture detected (Avg Angle: ${angleDisplay}°). Sit up straight.`);
        } else {
            // GOOD POSTURE
            consecutiveBadPosture = 0;
            violationCounters.posture = 0; 
            updateProctoringUI('good', 'Good', `Good posture maintained. (Avg Angle: ${angleDisplay}° - less than ${POSTURE_WARN_ANGLE}°)`);
        }

        // 5. NO DRAWING CODE HERE (as requested)
        // Ensure you remove any existing calls to drawKeypoints or any other visualization code within analyzePose.

    } catch (e) {
        console.error('Pose analysis error:', e);
    }
}


async function analyzeFaceAndObjects() {
  // face direction (optional)
  try {
    if (faceMeshModel && videoElem && videoElem.readyState >= 2) {
      const faces = await faceMeshModel.estimateFaces({ input: videoElem });
      if (!faces || faces.length === 0) {
        // no face visible
        handleViolation('faceAbsent', 'Face not visible to camera');
      } else {
        // use first face
        const f = faces[0];
        let leftEye = null, rightEye = null, nose = null;
        
        // Standard FaceMesh Annotation Check (more reliable)
        if (f.annotations && f.annotations.leftEyeUpper0 && f.annotations.rightEyeUpper0 && f.annotations.noseTip) {
          leftEye = f.annotations.leftEyeUpper0[3];
          rightEye = f.annotations.rightEyeUpper0[3];
          nose = f.annotations.noseTip[0];
        } else if (f.scaledMesh && f.scaledMesh.length > 0) {
          // Fallback: approximate indices (less reliable)
          const mesh = f.scaledMesh;
          leftEye = { x: mesh[33][0], y: mesh[33][1] };
          rightEye = { x: mesh[263][0], y: mesh[263][1] };
          nose = { x: mesh[1][0], y: mesh[1][1] };
        }

        if (leftEye && rightEye && nose) {
          const midEyeX = (leftEye.x + rightEye.x) / 2;
          const yaw = (midEyeX - nose.x); // raw pixel offset
          const faceWidth = Math.abs(leftEye.x - rightEye.x) || 1;
          const yawNorm = (yaw / faceWidth) * 100; // normalized yaw

          // **IMPROVED THRESHOLD (YawNorm: 18%)**
          if (Math.abs(yawNorm) > 18) { 
            handleViolation('lookAway', `Looking away (${yawNorm.toFixed(1)}% yaw)`);
          } else {
            violationCounters.lookAway = 0;
          }
          
          // **🔥 REMOVE THE drawHeadArrow CALL HERE (IF IT WAS PRESENT) 🔥**
        }
      }
    }
  } catch (e) {
    console.warn('face analysis skipped or failed', e);
  }

  // object detection (phone)
  try {
    if (cocoModel && videoElem && videoElem.readyState >= 2) {
      const preds = await cocoModel.detect(videoElem);
      
      // **🔥 REMOVE drawObjectBoxesScaled(preds) CALL IF PRESENT 🔥**
      // We only check for the phone object, no drawing
      
      // **IMPROVED: Stricter confidence (0.95)**
      const phone = preds.find(p => p.class && p.class.toLowerCase().includes('phone') && p.score > 0.8);
      if (phone) handleViolation('phone', `Prohibited device detected (phone, Score: ${(phone.score*100).toFixed(0)}%)`); // Add score for debug
      else violationCounters.phone = 0;
      }
  } catch (e) {
    console.warn('object detection failed', e);
  }
}





//// TTS FIX ////
function speakQuestion(text) {
  if (!text) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  setTimeout(() => {
    const chunks = text.match(/.{1,100}(\s|$)/g) || [text];
    let i = 0;
    function speakNext() {
      if (i >= chunks.length) return;
      const u = new SpeechSynthesisUtterance(chunks[i]);
      u.rate = 0.95;
      u.onend = () => { i++; speakNext(); };
      synth.speak(u);
    }
    speakNext();
  }, 200);
}



///// QUESTIONS FETCH /////
async function fetchQuestionsFromServer(domain, level) {
  try {
    const res = await fetch('/api/generate-questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain || 'general', level: level || 'medium' })
    });
    if (!res.ok) throw new Error('Server error');
    const data = await res.json();
    if (data && Array.isArray(data.questions) && data.questions.length > 0) {
      return data.questions;
    }
    throw new Error('No questions returned');
  } catch (e) {
    console.warn('fetchQuestions failed:', e);
    return null;
  }
}

///// FLOW: Start / Stop / Events /////
async function startInterviewFlow() {
  // Get DOM refs
  const loader = safeEl('loader');
  const loaderText = safeEl('loader-text');
  if (loader) loader.style.display = 'flex';
  if (loaderText) loaderText.textContent = 'Requesting camera access...';

  ensureVideoAndOverlay();

  // Get camera
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    videoElem.srcObject = stream;
    await videoElem.play();
  } catch (e) {
    console.error('Camera permission error', e);
    if (loaderText) loaderText.textContent = 'Camera access is required. Please allow camera and refresh.';
    showToast('Camera permission required');
    return;
  }

  // Load ML models
  if (loaderText) loaderText.textContent = 'Loading ML models (this may take a few seconds)...';
  await loadModelsWithFallback();

  // Fit overlay to actual video size
  // small timeout to let browser set video size
  await new Promise(r => setTimeout(r, 250));
  const rect = videoElem.getBoundingClientRect();
  overlayCanvas.width = rect.width;
  overlayCanvas.height = rect.height;
  overlayCanvas.style.left = rect.left + 'px';
  overlayCanvas.style.top = rect.top + 'px';

  // Wire window event listeners
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) handleViolation('tabSwitch', 'Switched tab or minimized window');
  });
  window.addEventListener('blur', () => handleViolation('focusLost', 'Switched focus from interview window'));
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) handleViolation('fullscreen', 'Exited fullscreen mode');
  });

  // Fetch questions
  if (loaderText) loaderText.textContent = 'Generating interview questions...';
  const domain = sessionStorage.getItem('domain');
  const difficulty = sessionStorage.getItem('level');
  const qFromServer = await fetchQuestionsFromServer(domain, difficulty);
  if (qFromServer && qFromServer.length > 0) {
    questions = qFromServer;
  }
  //  else {
  //   // fallback sample questions - will still let interview run
  //   questions = [
  //     'Tell me about yourself.',
  //     'Explain a challenging project you worked on.',
  //     'How do you handle deadlines?'
  //   ];
  // }

  // Hide loader and show interview UI
  if (loader) loader.style.display = 'none';
  
  // Show strike counter
  const strikeCounter = safeEl('strike-counter');
  if (strikeCounter) strikeCounter.classList.add('visible');

  // Show interview container
  const container = safeEl('interview-container');
  if (container) container.style.display = 'grid';
  
  displayQuestion();

  // start detection loops
  poseIntervalId = setInterval(analyzePose, POSE_CHECK_MS);
  objectIntervalId = setInterval(analyzeFaceAndObjects, OBJECT_CHECK_MS);

  // start speech recognition
  startSpeechRecognition();
}

///// UI: question / answers /////
function displayQuestion() {
  const container = safeEl('interview-container');
  if (container) container.style.display = 'flex';
  const qText = safeEl('question-text');
  const qCount = safeEl('question-counter');
  if (qText) qText.textContent = questions[currentIndex] || 'Loading...';
  if (qCount) qCount.textContent = `Question ${currentIndex + 1} of ${questions.length}`;
  // Speak question (TTS)
  speakQuestion(questions[currentIndex] || '');

  // 🔥 NEW: Start the 1-minute timer
  startQuestionTimer();
}

function speakQuestion(text) {
  if (!text) return;
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    synth.speak(u);
  } catch (e) { /* ignore */ }
}

function saveAnswerAndProceed() {
  if (recognition) recognition.stop();
  const ta = safeEl('typed-answer');
  const response = (ta && ta.value.trim()) || 'No answer provided';
  answers.push({ question: questions[currentIndex], response });
  currentIndex++;
  if (questionTimerId) {
    clearTimeout(questionTimerId);
    questionTimerId = null;
  }
  if (currentIndex < questions.length) {
    const ta = safeEl('typed-answer');
    displayQuestion();
    // 🔥 Restart speech recognition for next question
    startSpeechRecognition();
  } else {
    evaluateInterview();
  }
}

async function evaluateInterview() {
  // disable loops
  if (poseIntervalId) clearInterval(poseIntervalId);
  if (objectIntervalId) clearInterval(objectIntervalId);

  // show loader
  const loader = safeEl('loader');
  const loaderText = safeEl('loader-text');
  if (loader) loader.style.display = 'flex';
  if (loaderText) loaderText.textContent = 'Evaluating your answers...';

  try {
    const res = await fetch('/api/evaluate-responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers, posture: { spineAngle: avgAngle().toFixed(2) }, domain: sessionStorage.getItem('domain') })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Evaluation failed');
    // show evaluation
    showEvaluation(data.evaluation);
  } catch (e) {
    console.error('Evaluation error', e);
    showToast('Evaluation failed. See console for details.');
  } finally {
    if (loader) loader.style.display = 'none';
  }
}

function showEvaluation(evaluation) {
  const evalSection = safeEl('evaluation-section');
  if (!evalSection) return;
  // populate fields
  const prof = safeEl('overall-proficiency');
  const fb = safeEl('overall-feedback');
  if (prof) prof.textContent = evaluation?.overall_proficiency || 'N/A';
  if (fb) fb.textContent = evaluation?.feedback || 'N/A';
  const tbody = document.querySelector('#feedback-table tbody');
  if (tbody) {
    tbody.innerHTML = '';
    const rows = evaluation?.results || [];
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3">No detailed feedback available.</td></tr>`;
    } else {
      rows.forEach(r => {
        const row = tbody.insertRow();
        row.innerHTML = `<td style="padding:8px;border:1px solid #ddd">${r.question||'N/A'}</td>
                         <td style="padding:8px;border:1px solid #ddd">${r.score||'N/A'}/10</td>
                         <td style="padding:8px;border:1px solid #ddd">${r.improvement||'N/A'}</td>`;
      });
    }
  }
  evalSection.style.display = 'block';
}

///// SPEECH RECOGNITION /////
function startSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;
  try {
    if (recognition) recognition.abort();
    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    let finalTranscript = '';
    recognition.onresult = (evt) => {
      let interim = '';
      for (let i = evt.resultIndex; i < evt.results.length; ++i) {
        if (evt.results[i].isFinal) finalTranscript += evt.results[i][0].transcript + ' ';
        else interim += evt.results[i][0].transcript;
      }
      const ta = safeEl('typed-answer');
      if (ta) ta.value = finalTranscript + interim;
    };
    recognition.onerror = (e) => { console.warn('Speech recognition error', e); };
    recognition.start();
  } catch (e) {
    console.warn('SpeechRecognition not available', e);
  }
}

///// PRESTART MODAL /////
function showPrestartModal() {
  if (safeEl('prestart-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'prestart-modal';
  modal.style.position = 'fixed';
  modal.style.inset = '0';
  modal.style.background = 'rgba(0,0,0,0.7)';
  modal.style.display = 'flex';
  modal.style.alignItems = 'center';
  modal.style.justifyContent = 'center';
  modal.style.zIndex = 100000;
  modal.innerHTML = `
    <div style="background:white; padding:22px; border-radius:10px; width:90%; max-width:720px; text-align:left">
      <h2 style="margin-top:0">Interview rules & recommended setup</h2>
      <ul>
        <li>Please accept camera & mic access.</li>
        <li>Use fullscreen (recommended).</li>
        <li>Do not switch tabs or use other devices.</li>
        <li>Keep head & upper body visible in camera.</li>
      </ul>
      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:12px;">
        <button id="prestart-cancel" style="padding:8px 12px;">Cancel</button>
        <button id="prestart-start" style="padding:8px 12px;background:#2563eb;color:#fff;border:none;border-radius:6px;">Start Interview</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  $('prestart-start').addEventListener('click', async () => {
    try { if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); } catch (e) {}
    modal.remove();
    await startInterviewFlow();
  });
  $('prestart-cancel').addEventListener('click', () => {
    modal.remove();
    window.location.href = '/home_index.html';
  });
}

///// BOOT /////
document.addEventListener('DOMContentLoaded', () => {
  // ensure UI elements exist; otherwise create some minimal placeholders:
  if (!safeEl('loader')) {
    const loader = document.createElement('div'); loader.id = 'loader'; loader.style.display = 'none';
    const loaderText = document.createElement('p'); loaderText.id = 'loader-text';
    loader.appendChild(loaderText); document.body.appendChild(loader);
  }
  if (!safeEl('interview-video')) {
    const video = document.createElement('video'); video.id = 'interview-video';
    video.width = 640; video.height = 480; video.autoplay = true; video.muted = true; video.playsInline = true;
    document.body.prepend(video);
  }
  if (!safeEl('overlay-canvas')) {
    const c = document.createElement('canvas'); c.id = 'overlay-canvas';
    c.width = 640; c.height = 480; c.style.position = 'absolute'; c.style.left = '0px'; c.style.top = '0px';
    c.style.pointerEvents = 'none'; document.body.insertBefore(c, document.querySelector('#interview-container') || null);
  }
  if (!safeEl('posture-status')) {
    const p = document.createElement('div'); p.id = 'posture-status'; p.className = 'posture-tag'; p.textContent = 'Posture: Awaiting analysis';
    document.body.appendChild(p);
  }
  if (!safeEl('posture-recommendation')) {
    const r = document.createElement('p'); r.id = 'posture-recommendation'; document.body.appendChild(r);
  }
  if (!safeEl('strike-counter')) {
    const sc = document.createElement('div'); sc.id = 'strike-counter'; sc.style.position='fixed'; sc.style.left='10px'; sc.style.top='10px'; sc.style.background='rgba(255,255,255,0.9)'; sc.style.padding='6px 10px'; sc.style.borderRadius='8px'; sc.style.zIndex=99999; sc.textContent=`Strikes: ${strikes}/${MAX_STRIKES}`; document.body.appendChild(sc);
  }

  // wire next button
  const nextBtn = safeEl('next-question');
  if (nextBtn) nextBtn.addEventListener('click', saveAnswerAndProceed);

  // Wire up the start interview button
  const startBtn = safeEl('start-interview-btn');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      // Store selected domain
      const domain = safeEl('domain')?.value;
      const level = 'medium'; // Default level
      if (domain) {
        sessionStorage.setItem('domain', domain);
        sessionStorage.setItem('level', level);
      }
      
      // Show instructions modal
      const modal = safeEl('instructions-modal');
      if (modal) modal.classList.add('show');
    });
  }

  // Wire up the instructions modal buttons
  const instructionsStart = safeEl('instructions-start');
  const instructionsCancel = safeEl('instructions-cancel');
  
  if (instructionsStart) {
    instructionsStart.addEventListener('click', async () => {
      const modal = safeEl('instructions-modal');
      if (modal) modal.classList.remove('show');
      
      try {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
      } catch (e) { /* ignore */ }
      
      await startInterviewFlow();
    });
  }

  if (instructionsCancel) {
    instructionsCancel.addEventListener('click', () => {
      window.location.href = '/home_index.html';
    });
  }

  // Initialize strike counter visibility
  updateStrikeUI();

  // Show initial setup UI
  const container = safeEl('interview-container');
  const evalSection = safeEl('evaluation-section');
  if (container) container.style.display = 'none';
  if (evalSection) evalSection.style.display = 'none';
});
