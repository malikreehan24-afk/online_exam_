import React, { useState, useEffect, useRef } from 'react';
import { 
  Shield, 
  User, 
  LogOut, 
  Camera, 
  CameraOff, 
  AlertTriangle, 
  CheckCircle, 
  Activity,
  History,
  Play,
  StopCircle,
  Clock,
  Trash2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  GoogleAuthProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged,
  User as FirebaseUser
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  serverTimestamp,
  doc,
  updateDoc
} from 'firebase/firestore';
import { auth, db } from './lib/firebase';
import * as faceapi from '@vladmandic/face-api';
import { GoogleGenAI } from '@google/genai';

// --- Types ---
interface Violation {
  id: string;
  type: 'no_face' | 'multiple_faces' | 'suspicious_movement' | 'audio_alert';
  timestamp: any;
  description: string;
}

interface Session {
  id: string;
  userId: string;
  startTime: any;
  status: 'active' | 'completed' | 'cancelled';
  integrityScore: number;
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [cameraActive, setCameraActive] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [monitoringStatus, setMonitoringStatus] = useState<'clear' | 'warning' | 'alert'>('clear');
  const [lastAlert, setLastAlert] = useState<string | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const monitoringIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // --- Auth Effect ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // --- Face API Loading ---
  useEffect(() => {
    const loadModels = async () => {
      try {
        // Use CDN for models if not local
        const MODEL_URL = 'https://raw.githubusercontent.com/vladmandic/face-api/master/model/';
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
          faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL)
        ]);
        console.log('FaceAPI Models Loaded');
      } catch (err) {
        console.error('Error loading FaceAPI models:', err);
      }
    };
    loadModels();
  }, []);

  // --- Session Data Effect ---
  useEffect(() => {
    if (!user) return;
    
    // Listen for active sessions
    const q = query(
      collection(db, 'sessions'),
      where('userId', '==', user.uid),
      where('status', '==', 'active')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const docData = snapshot.docs[0];
        setSession({ id: docData.id, ...docData.data() } as Session);
      } else {
        setSession(null);
      }
    });

    return () => unsubscribe();
  }, [user]);

  // --- Violations Data Effect ---
  useEffect(() => {
    if (!session) {
      setViolations([]);
      return;
    }

    const q = query(
      collection(db, `sessions/${session.id}/violations`),
      orderBy('timestamp', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const vList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as Violation[];
      setViolations(vList);
    });

    return () => unsubscribe();
  }, [session]);

  const handleSignIn = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error('Sign in error:', err);
    }
  };

  const handleSignOut = async () => {
    if (isMonitoring) stopMonitoring();
    await signOut(auth);
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraActive(true);
      setMediaError(null);
    } catch (err) {
      setMediaError('Could not access camera. Please check permissions.');
      console.error(err);
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  };

  const startSession = async () => {
    if (!user) return;
    try {
      const docRef = await addDoc(collection(db, 'sessions'), {
        userId: user.uid,
        startTime: serverTimestamp(),
        status: 'active',
        integrityScore: 100
      });
      // Start camera if not already active
      if (!cameraActive) await startCamera();
      setIsMonitoring(true);
    } catch (err) {
      console.error('Error starting session:', err);
    }
  };

  const stopMonitoring = async () => {
    setIsMonitoring(false);
    if (monitoringIntervalRef.current) clearInterval(monitoringIntervalRef.current);
    if (session) {
      const sessionRef = doc(db, 'sessions', session.id);
      await updateDoc(sessionRef, { status: 'completed' });
    }
    stopCamera();
    setMonitoringStatus('clear');
  };

  // --- Monitoring Loop ---
  useEffect(() => {
    if (isMonitoring && cameraActive && videoRef.current) {
      monitoringIntervalRef.current = setInterval(async () => {
        if (!videoRef.current || !session) return;
        
        const detections = await faceapi.detectAllFaces(
          videoRef.current, 
          new faceapi.TinyFaceDetectorOptions()
        );

        if (detections.length === 0) {
          logViolation('no_face', 'No face detected in the frame.');
          setMonitoringStatus('alert');
          setLastAlert('Face Missing');
        } else if (detections.length > 1) {
          logViolation('multiple_faces', `${detections.length} faces detected.`);
          setMonitoringStatus('alert');
          setLastAlert('Extra Person Detected');
        } else {
          setMonitoringStatus('clear');
          setLastAlert(null);
        }
      }, 5000); // Check every 5 seconds
    }
    return () => {
      if (monitoringIntervalRef.current) clearInterval(monitoringIntervalRef.current);
    };
  }, [isMonitoring, cameraActive, session]);

  const logViolation = async (type: Violation['type'], description: string) => {
    if (!session) return;
    try {
      await addDoc(collection(db, `sessions/${session.id}/violations`), {
        type,
        timestamp: serverTimestamp(),
        description
      });
      
      // Update score (simple penalty)
      const sessionRef = doc(db, 'sessions', session.id);
      await updateDoc(sessionRef, {
        integrityScore: Math.max(0, session.integrityScore - 5)
      });
    } catch (err) {
      console.error('Error logging violation:', err);
    }
  };

  const generateSummary = async () => {
    if (violations.length === 0) {
      setAiSummary("No violations were recorded. The student maintained perfect integrity.");
      return;
    }

    setIsSummarizing(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Analyze these proctoring violation logs for a student exam and provide a professional, concise summary of their integrity. 
        Logs: ${JSON.stringify(violations.map(v => ({ type: v.type, desc: v.description })))}`
      });
      setAiSummary(response.text || "Failed to generate summary.");
    } catch (err) {
      console.error('Gemini error:', err);
      setAiSummary("Error generating AI summary.");
    } finally {
      setIsSummarizing(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  // --- Auth Guard ---
  if (!user) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full bg-slate-900 rounded-3xl p-8 border border-slate-800 shadow-2xl text-center"
        >
          <div className="w-20 h-20 bg-blue-500/10 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Shield className="w-10 h-10 text-blue-500" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">ProctorGuard AI</h1>
          <p className="text-slate-400 mb-8">Secure AI-powered exam monitoring and integrity management.</p>
          
          <button
            onClick={handleSignIn}
            className="w-full bg-white text-slate-950 font-semibold py-4 rounded-xl flex items-center justify-center gap-3 hover:bg-slate-100 transition-colors shadow-lg"
          >
            <img src="https://www.google.com/favicon.ico" className="w-5 h-5" alt="Google" />
            Sign in with Google
          </button>
          
          <p className="text-xs text-slate-500 mt-6">
            By signing in, you agree to our terms of academic integrity.
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white flex">
      {/* Sidebar */}
      <aside className="w-64 border-r border-slate-800 bg-slate-900/50 flex flex-col">
        <div className="p-6 flex items-center gap-3">
          <Shield className="w-6 h-6 text-blue-500" />
          <span className="font-bold text-lg">ProctorGuard</span>
        </div>
        
        <nav className="flex-1 px-4 space-y-2 mt-4">
          <button className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-blue-500/10 text-blue-500 font-medium transition-colors">
            <Activity className="w-5 h-5" />
            Dashboard
          </button>
          <button className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-slate-400 hover:bg-slate-800 transition-colors">
            <History className="w-5 h-5" />
            Past Sessions
          </button>
        </nav>

        <div className="p-4 border-t border-slate-800">
          <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/50 mb-4">
            <div className="w-10 h-10 rounded-full bg-slate-700 overflow-hidden">
              <img src={user.photoURL || `https://ui-avatars.com/api/?name=${user.displayName}`} alt="Profile" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{user.displayName}</p>
              <p className="text-xs text-slate-500 truncate">{user.email}</p>
            </div>
          </div>
          <button 
            onClick={handleSignOut}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-16 border-bottom border-slate-800 px-8 flex items-center justify-between bg-slate-950/50 backdrop-blur-md sticky top-0 z-10">
          <h2 className="text-lg font-semibold">Monitoring Dashboard</h2>
          <div className="flex items-center gap-4">
            {isMonitoring && (
              <span className="flex items-center gap-2 px-3 py-1 bg-red-500/10 text-red-500 text-xs font-bold rounded-full animate-pulse">
                <span className="w-2 h-2 rounded-full bg-red-500" />
                LIVE MONITORING
              </span>
            )}
            <div className="text-xs text-slate-500">
              {new Date().toLocaleDateString()}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8">
          <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Camera Section */}
            <div className="lg:col-span-2 space-y-6">
              <div className="relative aspect-video bg-slate-900 rounded-3xl overflow-hidden border border-slate-800 group shadow-2xl">
                {cameraActive ? (
                  <>
                    <video 
                      ref={videoRef} 
                      autoPlay 
                      playsInline 
                      muted 
                      className="w-full h-full object-cover"
                    />
                    <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />
                    <div className="absolute top-4 left-4 flex gap-2">
                      <div className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                        monitoringStatus === 'clear' ? 'bg-green-500/20 text-green-500 border border-green-500/30' : 
                        monitoringStatus === 'warning' ? 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/30' :
                        'bg-red-500/20 text-red-500 border border-red-500/30'
                      }`}>
                        {monitoringStatus === 'clear' ? 'Normal' : monitoringStatus === 'warning' ? 'Check' : 'Alert'}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500">
                    <CameraOff className="w-16 h-16 mb-4 opacity-20" />
                    <p>Camera is currently inactive</p>
                    {mediaError && <p className="text-red-400 text-sm mt-2">{mediaError}</p>}
                  </div>
                )}
                
                {/* Controls Overlay */}
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-4">
                  {!isMonitoring ? (
                    <button 
                      onClick={startSession}
                      className="px-8 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-full font-bold flex items-center gap-2 shadow-xl transition-all hover:scale-105 active:scale-95"
                    >
                      <Play className="w-5 h-5 fill-current" />
                      Start Exam
                    </button>
                  ) : (
                    <button 
                      onClick={stopMonitoring}
                      className="px-8 py-3 bg-slate-100 hover:bg-white text-slate-950 rounded-full font-bold flex items-center gap-2 shadow-xl transition-all hover:scale-105 active:scale-95"
                    >
                      <StopCircle className="w-5 h-5" />
                      Stop Exam
                    </button>
                  ) }
                </div>
              </div>

              {/* Status Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-slate-900 p-6 rounded-3xl border border-slate-800">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 bg-blue-500/10 rounded-lg">
                      <Clock className="w-4 h-4 text-blue-500" />
                    </div>
                    <span className="text-sm font-medium text-slate-400">Duration</span>
                  </div>
                  <p className="text-2xl font-bold font-mono">00:00:00</p>
                </div>
                
                <div className="bg-slate-900 p-6 rounded-3xl border border-slate-800">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 bg-emerald-500/10 rounded-lg">
                      <CheckCircle className="w-4 h-4 text-emerald-500" />
                    </div>
                    <span className="text-sm font-medium text-slate-400">Integrity Score</span>
                  </div>
                  <p className="text-2xl font-bold">{session?.integrityScore ?? 100}%</p>
                </div>

                <div className="bg-slate-900 p-6 rounded-3xl border border-slate-800">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 bg-rose-500/10 rounded-lg">
                      <AlertTriangle className="w-4 h-4 text-rose-500" />
                    </div>
                    <span className="text-sm font-medium text-slate-400">Active Alerts</span>
                  </div>
                  <p className="text-2xl font-bold">{violations.length}</p>
                </div>
              </div>
            </div>

            {/* Sidebar Stats/Logs */}
            <div className="space-y-6">
              <div className="bg-slate-900 rounded-3xl border border-slate-800 overflow-hidden flex flex-col max-h-[600px]">
                <div className="p-6 border-b border-slate-800 flex items-center justify-between">
                  <h3 className="font-bold flex items-center gap-2">
                    <History className="w-5 h-5 text-slate-400" />
                    Integrity Logs
                  </h3>
                  {violations.length > 0 && !isMonitoring && (
                    <button 
                      onClick={generateSummary}
                      disabled={isSummarizing}
                      className="text-[10px] font-bold text-blue-400 hover:text-blue-300 transition-colors uppercase tracking-widest disabled:opacity-50"
                    >
                      {isSummarizing ? 'Analyzing...' : 'AI Summary'}
                    </button>
                  )}
                </div>
                
                {aiSummary && (
                  <div className="mx-4 mt-4 bg-blue-500/5 p-4 rounded-2xl border border-blue-500/10 text-xs text-blue-200 leading-relaxed italic">
                    <p className="font-bold mb-1 uppercase tracking-widest text-[9px] opacity-70">AI Insight</p>
                    {aiSummary}
                    <button onClick={() => setAiSummary(null)} className="mt-2 text-[9px] underline opacity-50 block">Clear</button>
                  </div>
                )}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {violations.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-slate-500 p-8 text-center">
                      <CheckCircle className="w-12 h-12 mb-4 opacity-20 text-emerald-500" />
                      <p className="text-sm">No violations detected. Keep up the high level of integrity!</p>
                    </div>
                  ) : (
                    violations.map((v) => (
                      <motion.div 
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        key={v.id} 
                        className="bg-slate-800/50 p-4 rounded-2xl border border-red-500/20"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[10px] font-bold text-red-400 uppercase tracking-widest">{v.type.replace('_', ' ')}</span>
                          <span className="text-[10px] text-slate-500">{v.timestamp?.toDate().toLocaleTimeString() || 'Just now'}</span>
                        </div>
                        <p className="text-sm text-slate-300 leading-relaxed font-mono">
                          {v.description}
                        </p>
                      </motion.div>
                    ))
                  )}
                </div>
              </div>

              {/* Guidance */}
              <div className="bg-blue-600/10 p-6 rounded-3xl border border-blue-500/20">
                <h4 className="font-bold text-blue-400 mb-2 flex items-center gap-2">
                  <CheckCircle className="w-4 h-4" />
                  Proctoring Active
                </h4>
                <p className="text-xs text-blue-300/80 leading-relaxed font-mono">
                  Your session is being monitored by AI. Stay centered in the frame and avoid external materials. Any suspicious behavior will be logged and flagged.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Warning Toast */}
      <AnimatePresence>
        {lastAlert && (
          <motion.div 
            initial={{ opacity: 0, y: 50, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 50, x: '-50%' }}
            className="fixed bottom-10 left-1/2 z-50 px-6 py-4 bg-red-600 text-white rounded-2xl shadow-2xl flex items-center gap-4 border-2 border-white/20"
          >
            <AlertTriangle className="w-6 h-6 animate-bounce" />
            <div>
              <p className="font-bold">Security Alert</p>
              <p className="text-sm opacity-90">{lastAlert}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
