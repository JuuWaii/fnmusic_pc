using FnMusic.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace FnMusic.App;

public sealed partial class MainWindow
{
    private bool favoritesView, favoriteBusy;
    private CancellationTokenSource favoriteWork = new();
    private async void Favorites_Click(object sender, RoutedEventArgs e)
    { await ShowFavoritesAsync(); }
    private async Task ShowFavoritesAsync()
    {
        favoritesView = true; parentArtist = null; collectionKind = null; collection = null;
        SearchInput.Text = searchQuery = ""; UpdateCollectionView(); await LoadPageAsync(1);
    }
    private void TrackSelection_Changed(object sender, SelectionChangedEventArgs e) => UpdateFavoriteButton();
    private void UpdateFavoriteButton()
    {
        if (FavoriteToggle is null) return;
        FavoriteToggle.IsEnabled = !favoriteBusy && TrackList.SelectedItem is MusicTrack;
        FavoriteToggle.Content = TrackList.SelectedItem is MusicTrack { IsFavorite: true } ? "取消收藏" : "收藏歌曲";
    }
    private async void Favorite_Click(object sender, RoutedEventArgs e)
    { await ToggleFavoriteAsync(); }
    private async Task ToggleFavoriteAsync()
    {
        if (favoriteBusy || TrackList.SelectedItem is not MusicTrack track) return;
        var api = ViewModel.AuthenticatedClient;
        if (api is null && !IsSyntheticPreview) { FavoriteStatus.Text = "请先登录后使用收藏。"; return; }
        var ct = favoriteWork.Token;
        var viewToken = libraryWork.Token;
        bool desired = !track.IsFavorite;
        favoriteBusy = true; UpdateFavoriteButton(); FavoriteStatus.Text = "正在更新收藏…";
        try
        {
#if DEBUG
            if (IsSyntheticPreview)
            {
                if (syntheticFavoriteFailure is { } failure)
                { syntheticFavoriteFailure = null; throw new MusicApiException(failure); }
                if (desired) syntheticFavorites.Add(track.Id); else syntheticFavorites.Remove(track.Id);
            }
            else
#endif
            await api!.SetFavoriteAsync(track.Reference, desired, ct);
            if (closed || ct.IsCancellationRequested || !ReferenceEquals(api, ViewModel.AuthenticatedClient)) return;
            FavoriteStatus.Text = desired ? "已收藏" : "已取消收藏";
            // 只更新操作开始时的页面；浏览切换不影响正在进行的写入。
            if (!viewToken.IsCancellationRequested && TrackList.ItemsSource is IEnumerable<MusicTrack> tracks)
            {
                if (favoritesView && !desired)
                    await LoadPageAsync(page > 1 && tracks.Count() == 1 ? page - 1 : page);
                else
                {
                    string? selectedId = (TrackList.SelectedItem as MusicTrack)?.Id;
                    var updated = tracks.Select(t => t.Id == track.Id ? t with { IsFavorite = desired } : t).ToArray();
                    TrackList.ItemsSource = updated;
                    TrackList.SelectedItem = updated.FirstOrDefault(t => t.Id == selectedId);
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (MusicApiException ex) when (ex.Failure == MusicFailure.Unauthorized)
        {
            if (!closed && !ct.IsCancellationRequested && ReferenceEquals(api, ViewModel.AuthenticatedClient))
                await ViewModel.ExpireSessionAsync();
        }
        catch (Exception)
        {
            if (!closed && !ct.IsCancellationRequested)
                FavoriteStatus.Text = "未能确认收藏结果，请刷新列表核对后重试。";
        }
        finally { favoriteBusy = false; if (!closed) UpdateFavoriteButton(); }
    }
}
