# Install and Run

Android only. The app was built and tested on an Android phone with an Innova 3210RS (an ELM327-compatible BLE OBD-II dongle).

## 1. One-time PC setup
1. **Node.js 20+**
2. **JDK 17** (e.g. Microsoft OpenJDK 17). Set `JAVA_HOME`.
3. **Android Studio**. In *SDK Manager*, install the Android SDK and Platform-Tools.
4. Set `ANDROID_HOME` = `%LOCALAPPDATA%\Android\Sdk` and add `%ANDROID_HOME%\platform-tools` to `PATH`.
5. From the repo root:
   ```bash
   npm install
   ```

## 2. Phone setup
1. Settings → About phone → tap **Build number** 7 times.
2. Settings → System → Developer options → turn on **USB debugging**.
3. Plug in over USB, accept the prompt, then check:
   ```bash
   adb devices
   ```

## 3. Run

### Option A: development build (Metro must stay running)
```bash
npm start
```
In a second terminal:
```bash
npx react-native run-android
```
If `run-android` fails to find Gradle on Windows, build and install directly:
```bash
cd android
```
```bash
.\gradlew.bat installDebug
```

### Option B: standalone APK (no PC needed afterwards)
```bash
cd android
```
```bash
.\gradlew.bat assembleRelease
```
```bash
adb install app/build/outputs/apk/release/app-release.apk
```
The release APK has the JS bundle embedded and is signed with the debug key, which is fine for your own phone.

## 4. Using the app

**OBD (Vehicle tab)**
1. Plug the 3210RS into the OBD-II port and turn the ignition **on**.
2. **Do not** pair it in Android Bluetooth settings (choose *Forget* if you already did).
3. Close the manufacturer's companion app. The dongle takes one connection at a time.
4. Tap **Connect & Read** and allow Bluetooth. The button turns amber (connecting), then green (**● Reading — cycle N**). The badge under the Vehicle tab shows OBD state and km/h on every screen.

**A tracked drive**
1. **Vehicle** → connect.
2. **Calibrate** → **● Start recording** (raw IMU, GPS and OBD speed to disk).
3. **Track** → **▶ Start**. Pick the engine from the legend: **● PDR**, **● INS**, **● Wheel**. Wheel is the one to use in a car.
4. Optional: **GPS-denied** hides GPS and the error figures until Stop.
5. Map buttons: **⌖ Fit** (whole trip), **🔒 Lock** (no auto-recentering), **⤓ Offline** (save tiles for the trip + 1.5 km).
6. Stop on Track, then stop the recording on Calibrate.

**Review**
- **Sessions** → open a recording to replay it (1×/8×/32×, scrub, switch engines) and export GPX / error CSV through the share sheet.

## 5. Tests
```bash
npm test
```
See [TEST_OVERVIEW.md](TEST_OVERVIEW.md).

## 6. Getting data off the phone
Recordings live at `/sdcard/Android/data/com.obdiidemoapp/files/recordings/rec-<time>`, or use **Email** in Sessions. Scrub before committing. See [test/README.md](../test/README.md).
