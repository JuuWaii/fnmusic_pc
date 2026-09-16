#if DEBUG
using System.Text.Json;
using FnMusic.Core;
using Microsoft.UI.Xaml;

namespace FnMusic.App;

public sealed partial class MainWindow
{
    // 窗口内状态回归：调用生产加载/导航方法并断言真实控件，不模拟鼠标事件。
    private async Task VerifyCollectionWindowAsync()
    {
        var checks = new Dictionary<string, bool>();
        string stage = "setup", error = "";
        void Verify(string name, bool value)
        { stage = name; checks[name] = value; if (!value) throw new InvalidOperationException(); }
        try
        {
            if (!Environment.GetCommandLineArgs().Contains("--preview-collections")) throw new InvalidOperationException();
            SettingsPanel.Visibility = Visibility.Collapsed; LibraryPanel.Visibility = Visibility.Visible;
            foreach (var kind in new[] { CollectionKind.Album, CollectionKind.Artist })
            {
                string prefix = kind == CollectionKind.Album ? "album" : "artist";
                await SwitchCollectionAsync(kind);
                Verify(prefix + "_first_page", page == 1 && total == 53 && !PreviousPage.IsEnabled && NextPage.IsEnabled &&
                    CollectionList.ItemsSource is IEnumerable<MusicCollection> firstItems && firstItems.Count() == 50);
                await LoadPageAsync(2);
                var items = (CollectionList.ItemsSource as IEnumerable<MusicCollection> ?? throw new InvalidOperationException()).ToArray();
                Verify(prefix + "_last_page", page == 2 && items.Length == 3 && items[0].Id == "collection-51" && PreviousPage.IsEnabled && !NextPage.IsEnabled);
                await OpenCollectionAsync(items[0]);
                Verify(prefix + "_detail_first_page", page == 1 && total == 53 && TrackList.Visibility == Visibility.Visible && NextPage.IsEnabled);
                await LoadPageAsync(2);
                var tracks = (TrackList.ItemsSource as IEnumerable<MusicTrack> ?? throw new InvalidOperationException()).ToArray();
                Verify(prefix + "_detail_last_page", tracks.Length == 3 && tracks[0].Id.EndsWith("-track-51") && !NextPage.IsEnabled && PreviousPage.IsEnabled);
                await ReturnToCollectionListAsync();
                Verify(prefix + "_return_page", page == 2 && CollectionList.Visibility == Visibility.Visible && CollectionOpen.IsEnabled);
                await OpenCollectionAsync(items[1]);
                Verify(prefix + "_empty_detail", total == 0 && !PreviousPage.IsEnabled && !NextPage.IsEnabled &&
                    TrackList.ItemsSource is IEnumerable<MusicTrack> emptyTracks && !emptyTracks.Any() && PageStatus.Text == "当前详情暂无曲目。");
                await ReturnToCollectionListAsync();
                var pending = OpenCollectionAsync(items[2]);
                Verify(prefix + "_loading", TrackList.ItemsSource is null && !PreviousPage.IsEnabled && !NextPage.IsEnabled);
                await SwitchCollectionAsync(kind == CollectionKind.Album ? CollectionKind.Artist : CollectionKind.Album);
                string expectedHeading = CollectionHeading.Text;
                await pending;
                Verify(prefix + "_stale_detail_ignored", collection is null && page == 1 && total == 53 && CollectionHeading.Text == expectedHeading &&
                    CollectionList.Visibility == Visibility.Visible && TrackList.ItemsSource is null && NextPage.IsEnabled);
                syntheticLibraryFailure = (MusicFailure.Unavailable, 0);
                await LoadPageAsync(1);
                Verify(prefix + "_network_error", CollectionList.ItemsSource is null && !CollectionOpen.IsEnabled &&
                    !PreviousPage.IsEnabled && !NextPage.IsEnabled && PageStatus.Text.StartsWith("加载失败"));
                await LoadPageAsync(1);
                Verify(prefix + "_network_retry", total == 53 && CollectionOpen.IsEnabled && NextPage.IsEnabled);
                var queuedTrack = new MusicTrack("synthetic-queued", "合成曲目", "测试夹具", 60, false);
                queue.Replace([queuedTrack], queuedTrack.Id);
                syntheticLibraryFailure = (MusicFailure.Unauthorized, 100);
                var staleFailure = LoadPageAsync(1);
                await SwitchCollectionAsync(kind);
                await staleFailure;
                Verify(prefix + "_stale_unauthorized_ignored", collectionKind == kind && total == 53 && queue.Count == 1 && CollectionOpen.IsEnabled);
                syntheticLibraryFailure = (MusicFailure.Unauthorized, 0);
                await LoadPageAsync(1);
                Verify(prefix + "_expired_session_reset", collectionKind is null && collection is null && queue.Count == 0 &&
                    CollectionList.ItemsSource is null && TrackList.ItemsSource is null && !NextPage.IsEnabled &&
                    CollectionHeading.Visibility == Visibility.Collapsed && PlaybackStatus.Text.StartsWith("登录已失效"));
            }
            stage = "complete";
        }
        catch (Exception ex) { error = ex.GetType().Name; }
        await File.WriteAllTextAsync(Path.Combine(AppContext.BaseDirectory, "collection-window-verification.json"),
            JsonSerializer.Serialize(new { timestamp = DateTimeOffset.UtcNow, stage, error, checks }));
    }
}
#endif
