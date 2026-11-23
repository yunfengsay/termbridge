import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiser;
import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiserConfig;
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserModelConfig;
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserGtcrnModelConfig;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Locale;

/** Native streaming probe, no raw fill when STFT delays output. Flush only at EOF.
 * Isolates enhancement; does not claim microphone DSP/VAD/car-noise acceptance. */
public final class OnlineDenoiseReplay {
  private static void append(ByteArrayOutputStream output, float[] samples) {
    for (float value : samples) {
      if (!Float.isFinite(value)) throw new IllegalStateException("Nonfinite model output");
      int sample = Math.max(-32768, Math.min(32767, (int)(Math.max(-1f, Math.min(1f, value)) * 32768f)));
      output.write(sample & 255);
      output.write((sample >> 8) & 255);
    }
  }

  public static void main(String[] args) throws Exception {
    if (args.length != 4) throw new IllegalArgumentException("model input.pcm output.pcm blockSamples");
    byte[] input = Files.readAllBytes(Paths.get(args[1]));
    int blockSize = Integer.parseInt(args[3]);
    if (blockSize < 1 || input.length == 0 || input.length % 2 != 0) throw new IllegalArgumentException("PCM/block alignment");
    ByteBuffer source = ByteBuffer.wrap(input).order(ByteOrder.LITTLE_ENDIAN);
    ByteArrayOutputStream output = new ByteArrayOutputStream(input.length + 2048);
    OfflineSpeechDenoiserModelConfig model = new OfflineSpeechDenoiserModelConfig();
    model.setGtcrn(new OfflineSpeechDenoiserGtcrnModelConfig(args[0]));
    model.setNumThreads(1);
    model.setProvider("cpu");
    OnlineSpeechDenoiser denoiser = new OnlineSpeechDenoiser(null, new OnlineSpeechDenoiserConfig(model));
    long started = System.nanoTime();
    int blocks = 0;
    try {
      while (source.remaining() > 0) {
        int n = Math.min(blockSize, source.remaining() / 2);
        float[] samples = new float[n];
        for (int i = 0; i < n; i++) samples[i] = source.getShort() / 32768f;
        append(output, denoiser.run(samples, 16000).getSamples());
        blocks++;
      }
      append(output, denoiser.flush().getSamples());
    } finally { denoiser.release(); }
    Files.write(Paths.get(args[2]), output.toByteArray());
    System.out.printf(Locale.ROOT, "{\"blocks\":%d,\"elapsedMs\":%.1f,\"inputBytes\":%d,\"outputBytes\":%d}%n",
      blocks, (System.nanoTime() - started) / 1e6, input.length, output.size());
  }
}
