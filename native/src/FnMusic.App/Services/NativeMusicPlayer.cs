using FnMusic.Infrastructure;
using Windows.Media.Core;
using Windows.Media.MediaProperties;
using Windows.Media.Playback;
using System.Runtime.InteropServices.WindowsRuntime;

namespace FnMusic.App.Services;

/// <summary>FFmpeg 解码为 PCM，Windows 媒体管线仅负责时钟、音量和设备输出。</summary>
public sealed class NativeMusicPlayer : IDisposable
{
    public MediaPlayer Player { get; } = new() { AutoPlay = false, Volume = 0.5 };
    private PcmSource? input;
    private MediaSource? source;
    public Task PendingCleanup { get; private set; } = Task.CompletedTask;
    public void Open(Stream stream, double durationSeconds)
    {
        Stop();
        try
        {
            _ = FfmpegPcmDecoder.FindExecutable();
            input = new PcmSource(stream, durationSeconds);
            source = MediaSource.CreateFromMediaStreamSource(input.Source);
            Player.Source = source;
            Player.Play();
        }
        catch { Stop(); stream.Dispose(); throw; }
    }
    public void Stop()
    {
        Player.Pause(); Player.Source = null;
        source?.Dispose(); source = null;
        var previous = input; input = null;
        if (previous is not null)
        {
            previous.Dispose();
            PendingCleanup = PendingCleanup.IsCompletedSuccessfully ? previous.Cleanup : Task.WhenAll(PendingCleanup, previous.Cleanup);
        }
    }
    public void Dispose() { Stop(); Player.Dispose(); }

    private sealed class PcmSource : IDisposable
    {
        private readonly Stream encoded;
        private readonly SemaphoreSlim gate = new(1);
        private readonly CancellationTokenSource lifetime = new();
        private FfmpegPcmDecoder? decoder;
        private long bytes;
        private TimeSpan offset;
        private bool disposed;
        public Task Cleanup { get; private set; } = Task.CompletedTask;
        public MediaStreamSource Source { get; }
        public PcmSource(Stream encoded, double duration)
        {
            this.encoded = encoded;
            Source = new MediaStreamSource(new AudioStreamDescriptor(AudioEncodingProperties.CreatePcm(48000, 2, 16)))
            { CanSeek = encoded.CanSeek && duration > 0, Duration = TimeSpan.FromSeconds(Math.Clamp(duration, 0, 864000)), BufferTime = TimeSpan.FromSeconds(1) };
            Source.Starting += Starting;
            Source.SampleRequested += SampleRequested;
        }
        private async void Starting(MediaStreamSource sender, MediaStreamSourceStartingEventArgs args)
        {
            var deferral = args.Request.GetDeferral();
            try
            {
                await gate.WaitAsync(lifetime.Token).ConfigureAwait(false);
                try
                {
                    if (disposed) return;
                    if (decoder is null || args.Request.StartPosition is not null)
                    {
                        if (decoder is not null) await decoder.DisposeAsync().ConfigureAwait(false);
                        encoded.Seek(0, SeekOrigin.Begin);
                        offset = args.Request.StartPosition ?? TimeSpan.Zero; bytes = 0;
                        decoder = new FfmpegPcmDecoder(encoded, offset);
                    }
                    args.Request.SetActualStartPosition(offset + TimeSpan.FromSeconds((double)bytes / FfmpegPcmDecoder.BytesPerSecond));
                }
                finally { gate.Release(); }
            }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
            catch (Exception) { if (!disposed) sender.NotifyError(MediaStreamSourceErrorStatus.Other); }
            finally { deferral.Complete(); }
        }
        private async void SampleRequested(MediaStreamSource sender, MediaStreamSourceSampleRequestedEventArgs args)
        {
            var deferral = args.Request.GetDeferral();
            try
            {
                await gate.WaitAsync(lifetime.Token).ConfigureAwait(false);
                try
                {
                    if (disposed || decoder is null) return;
                    byte[] pcm = new byte[19200]; // 100 ms，定长且受背压控制。
                    int count = 0;
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                    timeout.CancelAfter(TimeSpan.FromSeconds(30));
                    while (count < pcm.Length)
                    {
                        int read = await decoder.Output.ReadAsync(pcm.AsMemory(count), timeout.Token).ConfigureAwait(false);
                        if (read == 0) { await decoder.CheckCompletionAsync(timeout.Token).ConfigureAwait(false); break; }
                        count += read;
                    }
                    if (count == 0) { args.Request.Sample = null; return; }
                    if (count % FfmpegPcmDecoder.BytesPerFrame != 0) throw new IOException("Incomplete PCM frame.");
                    var sample = MediaStreamSample.CreateFromBuffer(pcm.AsBuffer(0, count), offset + TimeSpan.FromSeconds((double)bytes / FfmpegPcmDecoder.BytesPerSecond));
                    sample.Duration = TimeSpan.FromSeconds((double)count / FfmpegPcmDecoder.BytesPerSecond);
                    bytes += count;
                    args.Request.Sample = sample;
                }
                finally { gate.Release(); }
            }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
            catch (Exception) { if (!disposed) sender.NotifyError(MediaStreamSourceErrorStatus.Other); }
            finally { deferral.Complete(); }
        }
        public void Dispose()
        {
            if (disposed) return;
            disposed = true; lifetime.Cancel();
            Source.Starting -= Starting; Source.SampleRequested -= SampleRequested;
            Cleanup = ReleaseAsync();
        }
        private async Task ReleaseAsync()
        {
            await gate.WaitAsync().ConfigureAwait(false);
            try { if (decoder is not null) await decoder.DisposeAsync().ConfigureAwait(false); }
            catch (Exception) { /* 关闭窗口后的后台清理不得产生未观察异常或输出私人媒体信息。 */ }
            finally { encoded.Dispose(); lifetime.Dispose(); gate.Release(); }
        }
    }
}
