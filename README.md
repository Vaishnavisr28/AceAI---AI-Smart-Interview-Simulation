# AI Avatar Interview Simulation (Frontend)

A modern one-page React app with TailwindCSS, Framer Motion animations, and Three.js (react-three-fiber + drei) showing a GLTF avatar.

## Features
- Fixed glassy navbar with links: Home, About, Contact, Profile, Sign Up
- Hero with gradient CTA and animated 3D avatar
- About with modern cards and fade/slide animations
- Contact form with validation and hover effects
- Interview placeholder section with avatar and Next Question button
- Smooth scrolling between sections

## Tech
- React + Vite
- TailwindCSS
- Framer Motion
- three + @react-three/fiber + @react-three/drei

## Getting Started
1. Install Node.js LTS from https://nodejs.org
2. Install deps
   ```bash
   npm install
   ```
3. Place your GLTF model at `public/avatar.glb`
4. Run dev server
   ```bash
   npm run dev
   ```
5. Open `http://localhost:3000`

## Notes
- The avatar is loaded from `/avatar.glb` (public folder).
- OrbitControls limited (no zoom/pan) to keep focus on the avatar.





