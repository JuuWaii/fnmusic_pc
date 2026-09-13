#if DEBUG
using System.Text.Json;
using FnMusic.App.ViewModels;
using Windows.Devices.Enumeration;
using Windows.Media.Devices;
using Windows.Media.Playback;

namespace FnMusic.App.Services;

/// <summary>显式命令行启用的静音集成检查；只输出预定义阶段、布尔值和错误码。</summary>
internal static class PlaybackVerification
{
    public static async Task RunAsync(bool synthetic)
    {
        var checks = new Dictionary<string, bool>();
        string stage = "session", error = "";
        string errorModule = "";
        int errorCode = 0;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        using var connection = new ConnectionViewModel();
        using var audio = new NativeMusicPlayer();
        var player = audio.Player;
        player.IsMuted = true;
        int mediaError = 0;
        player.MediaFailed += (_, e) => Interlocked.Exchange(ref mediaError, e.ExtendedErrorCode?.HResult ?? -1);
        async Task Until(Func<bool> condition)
        {
            while (!condition())
            {
                if (Volatile.Read(ref mediaError) != 0) throw new IOException("Media failure.");
                await Task.Delay(100, timeout.Token);
            }
        }
        try
        {
            Stream stream;
            double duration;
            if (synthetic)
            {
                stream = CreateWave(); duration = 60;
                checks["synthetic_source"] = true;
            }
            else
            {
                await connection.InitializeAsync();
                var api = connection.AuthenticatedClient ?? throw new InvalidOperationException("No active session.");
                checks[stage] = true;
                stage = "library";
                var page = await api.ListTracksAsync(1, 50, timeout.Token);
                var track = page.Tracks.First(t => !t.IsCue && t.DurationSeconds > 40);
                checks[stage] = true;
                stream = await api.OpenTrackStreamAsync(track.Id, timeout.Token);
                duration = track.DurationSeconds;
            }
            stage = "open_and_advance";
            audio.Open(stream, duration);
            await Until(() => player.PlaybackSession.PlaybackState == MediaPlaybackState.Playing && player.PlaybackSession.Position.TotalSeconds >= 2);
            checks[stage] = true;
            stage = "pause";
            player.Pause();
            await Until(() => player.PlaybackSession.PlaybackState == MediaPlaybackState.Paused);
            double paused = player.PlaybackSession.Position.TotalSeconds;
            await Task.Delay(800, timeout.Token);
            if (Math.Abs(player.PlaybackSession.Position.TotalSeconds - paused) > 0.1) throw new IOException("Pause position changed.");
            checks[stage] = true;
            stage = "resume";
            player.Play();
            await Until(() => player.PlaybackSession.Position.TotalSeconds >= paused + 1);
            checks[stage] = true;
            stage = "seek";
            if (!player.PlaybackSession.CanSeek) throw new IOException("Seek unavailable.");
            player.PlaybackSession.Position = TimeSpan.FromSeconds(20);
            await Until(() => player.PlaybackSession.Position.TotalSeconds is >= 20 and < 25 && player.PlaybackSession.PlaybackState == MediaPlaybackState.Playing);
            double seeked = player.PlaybackSession.Position.TotalSeconds;
            await Until(() => player.PlaybackSession.Position.TotalSeconds >= seeked + 1);
            checks[stage] = true;
            stage = "device_enumerate";
            var devices = await DeviceInformation.FindAllAsync(MediaDevice.GetAudioRenderSelector());
            if (devices.Count == 0) throw new IOException("No output device.");
            checks[stage] = true;
            stage = "device_switch";
            player.AudioDevice = devices[0];
            if (player.AudioDevice?.Id != devices[0].Id) throw new IOException("Output device selection was not applied.");
            double beforeSwitch = player.PlaybackSession.Position.TotalSeconds;
            await Until(() => player.PlaybackSession.Position.TotalSeconds >= beforeSwitch + 1);
            player.AudioDevice = null;
            double beforeDefault = player.PlaybackSession.Position.TotalSeconds;
            await Until(() => player.PlaybackSession.Position.TotalSeconds >= beforeDefault + 1);
            checks[stage] = true;
            stage = "stop";
            audio.Stop();
            await audio.PendingCleanup.WaitAsync(TimeSpan.FromSeconds(10));
            if (player.Source is not null) throw new IOException("Playback source was not released.");
            checks[stage] = true;
            stage = "complete";
        }
        catch (Exception ex)
        {
            error = ex.GetType().Name;
            errorCode = Volatile.Read(ref mediaError) is var mediaCode && mediaCode != 0 ? mediaCode : ex.HResult;
            if (ex is FileNotFoundException missing) errorModule = Path.GetFileName(missing.FileName) ?? "";
        }
        finally
        {
            audio.Stop();
            try { await audio.PendingCleanup.WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (Exception) { checks["cleanup"] = false; stage = "cleanup"; }
            // bin 目录被版本控制和隐私扫描排除；报告不含曲目、地址、账户或设备 ID。
            await File.WriteAllTextAsync(Path.Combine(AppContext.BaseDirectory, "playback-verification.json"),
                JsonSerializer.Serialize(new { synthetic, complete = stage == "complete", stage, checks, error, errorCode, errorModule }));
        }
    }
    internal static MemoryStream CreateWave()
    {
        const int frames = 48000 * 60, size = frames * 4;
        var stream = new MemoryStream(size + 44);
        using (var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true))
        {
            writer.Write("RIFF"u8); writer.Write(size + 36); writer.Write("WAVEfmt "u8);
            writer.Write(16); writer.Write((short)1); writer.Write((short)2); writer.Write(48000);
            writer.Write(192000); writer.Write((short)4); writer.Write((short)16);
            writer.Write("data"u8); writer.Write(size);
            for (int i = 0; i < frames; i++)
            {
                short sample = (short)(Math.Sin(2 * Math.PI * 440 * i / 48000) * 1000);
                writer.Write(sample); writer.Write(sample);
            }
        }
        stream.Position = 0;
        return stream;
    }
}
#endif
