import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiser;
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserConfig;
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserModelConfig;
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserGtcrnModelConfig;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Locale;

/** Historical baseline probe: offline model/AAR and old 4096-sample production calls.
 * Isolates denoising only; excludes microphone DSP, Silero gate and speaker checks.
 * No APK installation, microphone recording, network or TermBridge state access.
 */
public final class DenoiseReplay {
  public static void main(String[] args) throws Exception {
    if (args.length < 3 || args.length > 4) throw new IllegalArgumentException("model input.pcm output.pcm [blockSamples; 0=whole]");
    byte[] input = Files.readAllBytes(Paths.get(args[1]));
    if (input.length == 0 || input.length % 2 != 0) throw new IllegalArgumentException("PCM16 alignment");
    int blockSize = args.length == 4 ? Integer.parseInt(args[3]) : 4096;
    if (blockSize < 0) throw new IllegalArgumentException("blockSamples must be nonnegative");
    if (blockSize == 0) blockSize = input.length / 2;
    ByteBuffer source = ByteBuffer.wrap(input).order(ByteOrder.LITTLE_ENDIAN);
    ByteBuffer output = ByteBuffer.allocate(input.length).order(ByteOrder.LITTLE_ENDIAN);
    OfflineSpeechDenoiserModelConfig model = new OfflineSpeechDenoiserModelConfig();
    model.setGtcrn(new OfflineSpeechDenoiserGtcrnModelConfig(args[0]));
    model.setNumThreads(1);
    model.setProvider("cpu");
    OfflineSpeechDenoiser denoiser = new OfflineSpeechDenoiser(null, new OfflineSpeechDenoiserConfig(model));
    long started = System.nanoTime();
    int blocks = 0;
    int fallbackSamples = 0;
    double before = 0;
    double after = 0;
    try {
      while (source.remaining() > 0) {
        int n = Math.min(blockSize, source.remaining() / 2);
        float[] samples = new float[n];
        for (int i = 0; i < n; i++) samples[i] = source.getShort() / 32768f;
        float[] cleaned = denoiser.run(samples, 16000).getSamples();
        for (int i = 0; i < n; i++) {
          float value = i < cleaned.length ? cleaned[i] : samples[i];
          if (i >= cleaned.length) fallbackSamples++;
          short sample = (short)Math.max(-32768, Math.min(32767, (int)(Math.max(-1f, Math.min(1f, value)) * 32768f)));
          output.putShort(sample);
          before += samples[i] * samples[i];
          after += (sample / 32768.0) * (sample / 32768.0);
        }
        blocks++;
      }
    } finally { denoiser.release(); }
    Files.write(Paths.get(args[2]), output.array());
    System.out.printf(Locale.ROOT, "{\"blocks\":%d,\"fallbackSamples\":%d,\"elapsedMs\":%.1f,\"rmsRatio\":%.4f,\"bytes\":%d}%n",
      blocks, fallbackSamples, (System.nanoTime() - started) / 1e6, Math.sqrt(after / Math.max(before, 1e-12)), input.length);
  }
}
