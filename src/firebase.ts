import { getApps, initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  setPersistence,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { OWNER_EMAIL } from './notesCore';

export const APP_NAME = 'notes';

// Notes shares Harsh's existing pickledgerpro Firebase project, but uses its
// own named app and notes_users collection so its auth and data stay isolated
// from the other harsh.bet tools on the same origin.
const firebaseConfig = {
  apiKey: 'AIzaSyATQK7NHNXIshlJIy7xT17z8Kr8fUWatLs',
  authDomain: 'pickledgerpro.firebaseapp.com',
  projectId: 'pickledgerpro',
  storageBucket: 'pickledgerpro.firebasestorage.app',
  messagingSenderId: '285462656063',
  appId: '1:285462656063:web:caa084d1daf04e04eab48a',
};

export const firebaseApp = getApps().find((app) => app.name === APP_NAME)
  ?? initializeApp(firebaseConfig, APP_NAME);

export const firebaseAuth = getAuth(firebaseApp);
export const authPersistenceReady = setPersistence(firebaseAuth, browserLocalPersistence);

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ login_hint: OWNER_EMAIL });

// getFirestore intentionally uses the SDK's default in-memory cache. Notes
// never enables persistentLocalCache, IndexedDB persistence, or app-owned
// local note storage.
export const notesFirestore = getFirestore(firebaseApp);
