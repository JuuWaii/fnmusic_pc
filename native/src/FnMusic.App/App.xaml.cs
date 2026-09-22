using Microsoft.UI.Xaml;

namespace FnMusic.App;

public partial class App : Application
{
    private Window? window;
    public App() => InitializeComponent();
    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
#if DEBUG
        if (Environment.GetCommandLineArgs().Contains("--verify-native-favorites"))
        { RunFavoriteVerification(); return; }
        if (Environment.GetCommandLineArgs().Contains("--verify-native-collections"))
        { RunCollectionVerification(); return; }
        if (Environment.GetCommandLineArgs().Contains("--verify-native-search"))
        { RunSearchVerification(); return; }
        if (Environment.GetCommandLineArgs().Any(a => a is "--verify-native-playback" or "--verify-synthetic-playback"))
        {
            RunPlaybackVerification();
            return;
        }
#endif
        window = new MainWindow();
        window.Activate();
    }
#if DEBUG
    private async void RunFavoriteVerification()
    { await Services.FavoriteVerification.RunAsync(); Exit(); }
    private async void RunCollectionVerification()
    { await Services.CollectionVerification.RunAsync(); Exit(); }
    private async void RunSearchVerification()
    { await Services.SearchVerification.RunAsync(); Exit(); }
    private async void RunPlaybackVerification()
    {
        await Services.PlaybackVerification.RunAsync(Environment.GetCommandLineArgs().Contains("--verify-synthetic-playback"));
        Exit();
    }
#endif
}
