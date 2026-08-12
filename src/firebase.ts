import { getApps, initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  setPersistence,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { OWNER_VAULT_APP_NAME, adoptSharedAuthSession } from './owner-vault';

export const APP_NAME = OWNER_VAULT_APP_NAME;
const LEGACY_APP_NAMES = ['notes'] as const;

// Notes shares the canonical named Firebase app so the owner session follows
// between harsh.bet routes; its data stays in `notes_users/{vaultId}`.
const firebaseConfig = {
  apiKey: 'AIzaSyATQK7NHNXIshlJIy7xT17z8Kr8fUWatLs',
  authDomain: 'pickledgerpro.firebaseapp.com',
  projectId: 'pickledgerpro',
  storageBucket: 'pickledgerpro.firebasestorage.app',
  messagingSenderId: '285462656063',
  appId: '1:285462656063:web:caa084d1daf04e04eab48a',
};

adoptSharedAuthSession(firebaseConfig.apiKey, LEGACY_APP_NAMES);

export const firebaseApp = getApps().find((app) => app.name === APP_NAME)
  ?? initializeApp(firebaseConfig, APP_NAME);

export const firebaseAuth = getAuth(firebaseApp);
export const authPersistenceReady = setPersistence(firebaseAuth, browserLocalPersistence);

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// getFirestore intentionally uses the SDK's default in-memory cache. Notes
// never enables persistentLocalCache, IndexedDB persistence, or app-owned
// local note storage.
export const notesFirestore = getFirestore(firebaseApp);
