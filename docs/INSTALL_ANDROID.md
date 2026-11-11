# Installing on your Android phone

## Prerequisites (on your PC, one time)
1. **Node.js 20+** (you have it).
2. **JDK 17**: install e.g. Microsoft OpenJDK 17 and set `JAVA_HOME`.
3. **Android Studio**: install it, then open *SDK Manager* and install the Android SDK and Platform-Tools.
4. Set the environment variable `ANDROID_HOME` = `%LOCALAPPDATA%\Android\Sdk` and add `%ANDROID_HOME%\platform-tools` to `PATH`.
5. In this folder run:
   ```bash
   npm install
   ```

## Enable USB debugging on the phone
1. Settings → About phone → tap **Build number** 7 times.
2. Settings → System → Developer options → turn on **USB debugging**.
3. Plug the phone in by USB and accept the "Allow USB debugging" prompt.
4. Check that it's seen:
   ```bash
   adb devices
   ```

## Option A: run straight from the PC (development)
```bash
npx react-native run-android
```
This builds, installs and launches the app. Metro (the JS server) must keep running while you use it.

## Option B: standalone APK (no PC needed afterwards)
```bash
cd android
```
```bash
./gradlew assembleRelease
```
The APK is at `android/app/build/outputs/apk/release/app-release.apk`. The template signs it with the debug key, which is fine for your own phone. Install it:
```bash
adb install app/build/outputs/apk/release/app-release.apk
```
Or copy the APK to the phone and open it (allow "Install unknown apps" when asked).

## Using it
1. Plug the 3210RS into the car's OBD2 port and turn the ignition **on**.
2. **Do not** pair it in Android Bluetooth settings. If you already did, choose *Forget* there.
3. Open the app, tap **Connect & Read**, and allow the Bluetooth permission.
4. Trouble codes, RPM, speed and coolant temp appear on screen.
5. Close the manufacturer's companion app first. The dongle accepts only one connection at a time.
