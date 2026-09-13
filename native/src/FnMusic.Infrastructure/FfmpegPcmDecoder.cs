using System.Diagnostics;
using System.Globalization;

namespace FnMusic.Infrastructure;

/// <summary>隔离的 FFmpeg 解码进程。只接收歌曲字节，不接收 NAS 地址、Cookie 或文件名。</summary>
public sealed class FfmpegPcmDecoder : IAsyncDisposable
{
    public const int SampleRate = 48000, Channels = 2, BytesPerFrame = 4;
    public const int BytesPerSecond = SampleRate * BytesPerFrame;
    private readonly Process process;
    private readonly CancellationTokenSource lifetime = new();
    private readonly Task pump, drain;
    private Exception? inputError;
    private readonly object disposalLock = new();
    private Task? disposal;
    public Stream Output => process.StandardOutput.BaseStream;

    public static string FindExecutable()
    {
        // 发布包使用固定子目录；开发阶段允许已安装并配置到 PATH 的 FFmpeg。
        string bundled = Path.Combine(AppContext.BaseDirectory, "ffmpeg", "ffmpeg.exe");
        if (File.Exists(bundled)) return bundled;
        foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            string path = directory.Trim().Trim('"');
            if (!Path.IsPathFullyQualified(path)) continue;
            string candidate = Path.Combine(path, "ffmpeg.exe");
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException("FFmpeg decoder is unavailable.");
    }

    public FfmpegPcmDecoder(Stream input, TimeSpan start)
    {
        if (!input.CanRead || start < TimeSpan.Zero) throw new ArgumentException("Invalid audio input.");
        var info = new ProcessStartInfo(FindExecutable())
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        // 不允许媒体内容触发网络或本地文件读取；stdin/stdout 是唯一输入输出。
        foreach (string arg in new[] { "-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "pipe", "-i", "pipe:0",
            "-ss", start.TotalSeconds.ToString("0.######", CultureInfo.InvariantCulture), "-map", "0:a:0", "-vn", "-sn", "-dn",
            "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1" }) info.ArgumentList.Add(arg);
        process = Process.Start(info) ?? throw new IOException("Decoder could not start.");
        drain = DrainErrorsAsync();
        pump = PumpAsync(input);
    }
    private async Task PumpAsync(Stream input)
    {
        try { await input.CopyToAsync(process.StandardInput.BaseStream, 64 * 1024, lifetime.Token).ConfigureAwait(false); }
        catch (Exception error) { if (!lifetime.IsCancellationRequested) inputError = error; }
        finally { try { process.StandardInput.Close(); } catch (IOException) { } }
    }
    private async Task DrainErrorsAsync()
    {
        // 消费但不保留原始 FFmpeg 日志，其中可能包含歌曲元数据。
        try
        {
            char[] buffer = new char[2048];
            while (await process.StandardError.ReadAsync(buffer.AsMemory(), lifetime.Token).ConfigureAwait(false) > 0) { }
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
    }
    public async Task CheckCompletionAsync(CancellationToken ct)
    {
        await process.WaitForExitAsync(ct).ConfigureAwait(false);
        await pump.WaitAsync(ct).ConfigureAwait(false);
        if (process.ExitCode != 0 || inputError is not null) throw new IOException("Audio decoding failed.");
    }
    public ValueTask DisposeAsync()
    {
        lock (disposalLock) return new ValueTask(disposal ??= DisposeCoreAsync());
    }
    private async Task DisposeCoreAsync()
    {
        lifetime.Cancel();
        try { if (!process.HasExited) process.Kill(entireProcessTree: false); }
        catch (InvalidOperationException) { }
        await Task.WhenAll(pump, drain).ConfigureAwait(false);
        await process.WaitForExitAsync().ConfigureAwait(false);
        process.Dispose(); lifetime.Dispose();
    }
}
