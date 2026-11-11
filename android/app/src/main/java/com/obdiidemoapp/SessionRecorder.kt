package com.obdiidemoapp

import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.io.BufferedWriter
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Writes one recording session to <external files>/recordings/<id>/:
 *   meta.json        device, sensors, start/stop wall-clock, JS-supplied metadata
 *   imu_000.csv …    t,s,x,y,z,w   (s = a accel m/s², g gyro rad/s, m mag µT, r quat xyzw)
 *   gps.csv          t,lat,lon,alt,acc,speed,bearing,sats
 *   events.log       t + free text: app events, accuracy changes, 5 s health stats
 * Every file shares one clock: t = seconds since recording start, from the
 * monotonic elapsedRealtimeNanos base that sensor and location timestamps use.
 * Callers pass times relative to the sensor start (sensorT0Ns); this class
 * rebases them so t = 0 is the moment recording began.
 * IMU files rotate every [CHUNK_SECONDS] so each zipped part stays email-sized.
 *
 * Not thread-safe by itself: SensorModule calls it only from its sensor thread.
 */
class SessionRecorder(private val ctx: Context) {
  var id: String? = null; private set
  var t0Ns = 0L; private set
  /** Seconds between sensor start and recording start; subtracted from caller times. */
  private var offset = 0.0
  private var dir: File? = null
  private var imu: BufferedWriter? = null
  private var gps: BufferedWriter? = null
  private var events: BufferedWriter? = null
  private var chunk = 0
  private var chunkStartT = 0.0
  private val meta = JSONObject()

  // Running totals for the UI and the health log.
  var rows = LongArray(4); private set   // a, g, m, r
  var gpsFixes = 0L; private set
  var bytes = 0L; private set

  val active get() = id != null

  fun start(sensorT0Ns: Long, jsMeta: JSONObject, sensors: JSONObject): String {
    stop(JSONObject())
    val stamp = SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss", Locale.US).format(Date())
    val d = File(root(ctx), "rec-$stamp").apply { mkdirs() }
    t0Ns = android.os.SystemClock.elapsedRealtimeNanos()
    offset = (t0Ns - sensorT0Ns) / 1e9
    id = d.name
    dir = d
    chunk = 0
    chunkStartT = 0.0
    rows = LongArray(4)
    gpsFixes = 0
    bytes = 0
    imu = openImu()
    gps = writer("gps.csv").also { it.write("t,lat,lon,alt,acc,speed,bearing,sats\n") }
    events = writer("events.log")
    meta.apply {
      put("sensorStartOffsetS", offset)
      keys().asSequence().toList().forEach { remove(it) }
      put("id", d.name)
      put("startedAt", iso(Date()))
      put("device", JSONObject().apply {
        put("manufacturer", Build.MANUFACTURER)
        put("model", Build.MODEL)
        put("android", Build.VERSION.RELEASE)
        put("sdk", Build.VERSION.SDK_INT)
      })
      put("sensors", sensors)
      put("app", jsMeta)
      put("format", "see SessionRecorder.kt header; t = seconds since start, monotonic")
    }
    writeMeta()
    event("recording started ${d.name}")
    return d.name
  }

  fun imu(sensorT: Double, s: Char, x: Float, y: Float, z: Float, w: Float? = null) {
    val out = imu ?: return
    val t = sensorT - offset
    if (t - chunkStartT >= CHUNK_SECONDS) rotate(t)
    val line = if (w == null) "${fmt(t)},$s,$x,$y,$z\n" else "${fmt(t)},$s,$x,$y,$z,$w\n"
    out.write(line)
    bytes += line.length
    when (s) { 'a' -> rows[0]++; 'g' -> rows[1]++; 'm' -> rows[2]++; 'r' -> rows[3]++ }
  }

  fun gps(sensorT: Double, lat: Double, lon: Double, alt: Double, acc: Float, speed: Float,
          bearing: Float, sats: Int) {
    val out = gps ?: return
    val t = sensorT - offset
    val line = "${fmt(t)},$lat,$lon,$alt,$acc,$speed,$bearing,$sats\n"
    out.write(line)
    bytes += line.length
    gpsFixes++
  }

  fun event(msg: String, t: Double = nowT()) {
    val out = events ?: return
    val line = "${fmt(t)} $msg\n"
    out.write(line)
    bytes += line.length
    // Events are rare and the most useful thing in a post mortem: never lose them.
    out.flush()
  }

  /** Flush buffered rows so a crash loses at most ~1 s of samples. */
  fun flush() {
    imu?.flush()
    gps?.flush()
  }

  fun stop(jsMeta: JSONObject) {
    if (!active) return
    event("recording stopped; rows a/g/m/r=${rows.joinToString("/")} gps=$gpsFixes bytes=$bytes")
    meta.put("stoppedAt", iso(Date()))
    meta.put("durationS", nowT())
    meta.put("rows", JSONObject().apply {
      put("acc", rows[0]); put("gyr", rows[1]); put("mag", rows[2]); put("rot", rows[3])
      put("gps", gpsFixes)
    })
    meta.put("imuChunks", chunk + 1)
    val app = meta.optJSONObject("app") ?: JSONObject()
    jsMeta.keys().forEach { app.put(it, jsMeta.get(it)) }
    meta.put("app", app)
    writeMeta()
    listOf(imu, gps, events).forEach { runCatching { it?.close() } }
    imu = null; gps = null; events = null
    id = null; dir = null
  }

  fun nowT() = (android.os.SystemClock.elapsedRealtimeNanos() - t0Ns) / 1e9

  private fun rotate(t: Double) {
    imu?.close()
    chunk++
    chunkStartT = t
    imu = openImu()
    event("imu chunk $chunk started", t)
  }

  private fun openImu() =
    writer("imu_%03d.csv".format(chunk)).also { it.write("t,s,x,y,z,w\n") }

  private fun writer(name: String) =
    BufferedWriter(java.io.FileWriter(File(dir, name)), 1 shl 16)

  private fun writeMeta() = File(dir, "meta.json").writeText(meta.toString(2))

  companion object {
    const val CHUNK_SECONDS = 600.0
    /** Zipped attachments above this are split; Gmail's limit is 25 MB. */
    const val PART_BYTES = 18L * 1024 * 1024

    fun root(ctx: Context) =
      File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "recordings").apply { mkdirs() }

    private fun fmt(t: Double) = "%.6f".format(Locale.US, t)

    private fun iso(d: Date) =
      SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.US).apply {
        timeZone = TimeZone.getDefault()
      }.format(d)

    /** All sessions, newest first, with size and parsed meta. */
    fun list(ctx: Context): List<Pair<File, JSONObject>> =
      (root(ctx).listFiles() ?: emptyArray())
        .filter { it.isDirectory }
        .sortedByDescending { it.name }
        .map { d ->
          val m = runCatching { JSONObject(File(d, "meta.json").readText()) }
            .getOrDefault(JSONObject())
          m.put("bytes", d.listFiles()?.sumOf { it.length() } ?: 0L)
          d to m
        }

    /**
     * Zips a session into one or more parts in [outDir], each under PART_BYTES
     * (compressed). Part 1 always holds meta, events and gps so it alone is
     * enough to see what happened; IMU chunks fill the remaining parts.
     */
    fun zipParts(session: File, outDir: File, extra: Map<String, String>): List<File> {
      outDir.mkdirs()
      outDir.listFiles()?.forEach { it.delete() }
      val first = listOf("meta.json", "events.log", "gps.csv").map { File(session, it) }
        .filter { it.exists() }
      val imus = session.listFiles { f -> f.name.startsWith("imu_") }!!.sortedBy { it.name }
      val parts = mutableListOf<File>()
      var zip: ZipOutputStream? = null
      var out: File? = null
      fun open() {
        zip?.close()
        out = File(outDir, "${session.name}_part${parts.size + 1}.zip")
        parts += out!!
        zip = ZipOutputStream(FileOutputStream(out!!))
      }
      open()
      extra.forEach { (name, text) ->
        zip!!.putNextEntry(ZipEntry("${session.name}/$name"))
        zip!!.write(text.toByteArray())
        zip!!.closeEntry()
      }
      for (f in first + imus) {
        // Rough guess: CSV compresses ~4x. Start a new part before this one would overflow.
        if (f.name.startsWith("imu_") && out!!.length() > 0 &&
          out!!.length() + f.length() / 4 > PART_BYTES) open()
        zip!!.putNextEntry(ZipEntry("${session.name}/${f.name}"))
        FileInputStream(f).use { it.copyTo(zip!!) }
        zip!!.closeEntry()
        zip!!.flush()
      }
      zip?.close()
      return parts
    }
  }
}
