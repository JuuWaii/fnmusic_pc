using FnMusic.Core;
using Microsoft.UI.Xaml;

namespace FnMusic.App;

public sealed partial class MainWindow
{
    private bool IsSyntheticPreview =>
#if DEBUG
        Environment.GetCommandLineArgs().Contains("--preview-synthetic");
#else
        false;
#endif

    private async Task<Stream> OpenPlaybackStreamAsync(MusicTrack track, CancellationToken ct)
    {
#if DEBUG
        if (IsSyntheticPreview) return Services.PlaybackVerification.CreateWave();
#endif
        var api = ViewModel.AuthenticatedClient ?? throw new MusicApiException(MusicFailure.Unauthorized);
        return await api.OpenTrackStreamAsync(track.Id, ct);
    }
#if DEBUG
    // 显式测试入口隔离真实账户与曲名；仍使用生产 XAML、事件和播放器。
    private async Task ShowSyntheticPreviewAsync()
    {
        Title = "飞牛音乐 · 合成音频交互验证";
        SettingsPanel.Visibility = Visibility.Collapsed;
        LibraryPanel.Visibility = Visibility.Visible;
        TrackList.ItemsSource = new[]
        {
            new MusicTrack("synthetic-a", "合成测试音频 A", "测试夹具", 60, false),
            new MusicTrack("synthetic-b", "合成测试音频 B", "测试夹具", 60, false)
        };
        TrackList.SelectedIndex = 0;
        PageStatus.Text = "测试数据 · 不访问 NAS";
        PlaybackStatus.Text = "合成音频交互验证，默认静音。";
        music.Player.IsMuted = true; MuteToggle.IsChecked = true;
        await LoadDevicesAsync();
    }
#endif
}
