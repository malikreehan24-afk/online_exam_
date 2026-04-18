# ProctorGuard AI

Secure AI-powered online examination monitoring with face detection and integrity logging.

## Features
- **Face AI**: Real-time monitoring using `face-api.js` to detect absence or multiple people.
- **Firebase Auth**: Secure Google Sign-in.
- **Integrity Logs**: Automatic tracking of suspicious behavior in Firestore.
- **AI Summary**: Uses Gemini 3 Flash to generate a human-readable integrity report of the session.

## Getting Started on Your Laptop

### 1. Download the Code
Use the **Export to GitHub** or **Download ZIP** button in the AI Studio UI to get this updated code onto your computer.

### 2. Initial Setup
Open your terminal in the project folder and run:
```bash
npm install
```

### 3. Environment Variables
Create a file named `.env` in the root directory and add your keys:
```env
VITE_GEMINI_API_KEY=your_gemini_api_key_here
```
*(Note: In AI Studio, the Gemini key is handled automatically, but locally you'll need one from [aistudio.google.com](https://aistudio.google.com/app/apikey).)*

### 4. Firebase Configuration
The app uses the Firebase project created during development. If you want to use your own:
1. Go to the [Firebase Console](https://console.firebase.google.com/).
2. Create a new project.
3. Add a "Web App" and copy the config.
4. Replace the values in `firebase-applet-config.json` with your new project's config.
5. Enable **Google Authentication** and **Firestore** in the Firebase dashboard.

### 5. Run the App
```bash
npm run dev
```
The app will be available at `http://localhost:3000`.

## Scripts
- `npm run dev`: Starts the development server.
- `npm run build`: Builds the app for production.
- `npm run lint`: Checks for TypeScript errors.
