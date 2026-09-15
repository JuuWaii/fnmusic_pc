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
        Title = Environment.GetCommandLineArgs().Contains("--preview-search") ? "飞牛音乐 · 合成搜索交互验证" : "飞牛音乐 · 合成音频交互验证";
        SettingsPanel.Visibility = Visibility.Collapsed;
        LibraryPanel.Visibility = Visibility.Visible;
        await LoadPageAsync(1);
        PlaybackStatus.Text = "合成音频交互验证，默认静音。";
        music.Player.IsMuted = true; MuteToggle.IsChecked = true;
        await LoadDevicesAsync();
    }
    private static async Task<TrackPage> GetSyntheticPageAsync(string query, int requestedPage)
    {
        var tracks = new List<MusicTrack>
        {
            new MusicTrack("synthetic-a", "合成测试音频 A", "测试夹具", 60, false),
            new MusicTrack("synthetic-b", "合成测试音频 B", "测试夹具", 60, false)
        };
        if (Environment.GetCommandLineArgs().Contains("--preview-search"))
        {
            tracks.AddRange(Enumerable.Range(1, 120).Select(i => new MusicTrack($"synthetic-page-{i}", $"分页测试 {i:000}", "测试夹具", 60, false)));
            // 专用测试请求不响应取消，模拟已到达的旧响应，验证生产写回检查。
            if (query == "slow") { await Task.Delay(20000); query = "分页测试"; }
        }
        var found = tracks.Where(t => t.Title.Contains(query, StringComparison.OrdinalIgnoreCase)).ToArray();
        return new TrackPage(found.Skip((requestedPage - 1) * 50).Take(50).ToArray(), found.Length);
    }
#endif
}
