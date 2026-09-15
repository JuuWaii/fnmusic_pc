using FnMusic.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace FnMusic.App;

public sealed partial class MainWindow
{
    private CollectionKind? collectionKind;
    private MusicCollection? collection;
    private int collectionListPage = 1;
    private string CollectionLabel => collectionKind == CollectionKind.Album ? "专辑" : "歌手";
    private void UpdateCollectionView()
    {
        bool listing = collectionKind is not null && collection is null;
        CollectionList.Visibility = CollectionOpen.Visibility = listing ? Visibility.Visible : Visibility.Collapsed;
        TrackList.Visibility = listing ? Visibility.Collapsed : Visibility.Visible;
        CollectionBack.Visibility = collection is null ? Visibility.Collapsed : Visibility.Visible;
        CollectionHeading.Visibility = collectionKind is null ? Visibility.Collapsed : Visibility.Visible;
        CollectionHeading.Text = collection is null ? CollectionLabel : $"{CollectionLabel} · {collection.Name} · {collection.Summary}";
    }
    private async Task SwitchCollectionAsync(CollectionKind? kind)
    {
        collectionKind = kind; collection = null; collectionListPage = 1;
        SearchInput.Text = searchQuery = "";
        UpdateCollectionView();
        await LoadPageAsync(1);
    }
    private async void Songs_Click(object sender, RoutedEventArgs e) => await SwitchCollectionAsync(null);
    private async void Albums_Click(object sender, RoutedEventArgs e) => await SwitchCollectionAsync(CollectionKind.Album);
    private async void Artists_Click(object sender, RoutedEventArgs e) => await SwitchCollectionAsync(CollectionKind.Artist);
    private async void CollectionBack_Click(object sender, RoutedEventArgs e)
    { collection = null; UpdateCollectionView(); await LoadPageAsync(collectionListPage); }
    private async void CollectionOpen_Click(object sender, RoutedEventArgs e)
    { if (CollectionList.SelectedItem is MusicCollection item) await OpenCollectionAsync(item); }
    private async void Collection_ItemClick(object sender, ItemClickEventArgs e)
    { if (e.ClickedItem is MusicCollection item) await OpenCollectionAsync(item); }
    private async Task OpenCollectionAsync(MusicCollection item)
    {
        collectionListPage = page; collection = item;
        UpdateCollectionView(); await LoadPageAsync(1);
    }
}
