import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor wrapper config for the Android (and future iOS) build.
 *
 * - `webDir` points at Vite's static output. `npx cap sync` copies
 *   that folder into the native Android project (`android/app/src/main/assets/public`)
 *   on every build, so the APK ships the latest web bundle.
 * - `appId` is the reverse-domain Android package id; must stay
 *   unique across the device. Mirrors the Electron build's
 *   `com.gametotherescue.gonetogaia` for consistency.
 * - `appName` is what shows under the launcher icon. Same as
 *   Electron's `productName` for cross-platform parity.
 */
const config: CapacitorConfig = {
  appId: "com.gametotherescue.gonetogaia",
  appName: "GonetoGaia",
  webDir: "dist",
};

export default config;
