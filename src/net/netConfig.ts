/**
 * Online co-op configuration. Edit THIS file to switch transports.
 *
 *   "firebase" — Firebase Realtime Database + anonymous sign-in. Works
 *                between two computers (and between two tabs on one).
 *   "local"    — rooms in this browser's localStorage + BroadcastChannel.
 *                Only two tabs/windows on ONE computer; no internet needed.
 */
export const NET_TRANSPORT: "local" | "firebase" = "firebase";

/**
 * Firebase web-app config (Firebase console → Project settings → Your
 * apps → SDK setup and configuration). These values are public by
 * design; access is controlled by the Realtime Database rules (see
 * README "Multiplayer").
 */
export const FIREBASE_CONFIG: {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  appId: string;
} | null = {
  apiKey: "AIzaSyBsTPYfq5WlOLzhi27hZwjMVb-TnLJQa2Y",
  authDomain: "gone-to-gaia.firebaseapp.com",
  databaseURL: "https://gone-to-gaia-default-rtdb.firebaseio.com",
  projectId: "gone-to-gaia",
  appId: "1:870518805820:web:23cc980decf11b1fd5fa39",
};

/** Heartbeat cadence and the silence after which a peer shows as disconnected. */
export const HEARTBEAT_MS = 2000;
export const PEER_TIMEOUT_MS = 7000;
