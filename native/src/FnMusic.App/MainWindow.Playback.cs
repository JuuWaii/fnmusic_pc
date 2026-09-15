using FnMusic.App.Services;
using FnMusic.Core;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Windows.Devices.Enumeration;
using Windows.Media.Devices;
using Windows.Media.Playback;

namespace FnMusic.App;

public sealed partial class MainWindow
{
    private readonly NativeMusicPlayer music = new();
    private readonly PlaybackQueue queue = new();
    private CancellationTokenSource work = new();
    private CancellationTokenSource libraryWork = new();
    private string searchQuery = "";
    private string queueOrigin = "曲库当前页";
    private DispatcherQueueTimer? progressTimer;
    private DispatcherQueueTimer? seekTimer;
    private bool draggingSeek;
    private double? pendingSeek, submittedSeek;
    private DateTimeOffset seekDeadline;
    private int page = 1, total;
    private bool updatingProgress, closed, mediaReady;
    private sealed record OutputOption(string Name, DeviceInformation? Device);

    private void InitializePlayback()
    {
        // 单行 TextBox 会处理 Enter；仍接收该路由事件以提交搜索。
        SearchInput.AddHandler(UIElement.KeyDownEvent, new KeyEventHandler(Search_KeyDown), true);
        // Thumb 会处理指针事件，必须接收已处理事件才能可靠识别拖动结束。
        SeekSlider.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler(Seek_Pressed), true);
        SeekSlider.AddHandler(UIElement.PointerReleasedEvent, new PointerEventHandler(Seek_Released), true);
        SeekSlider.AddHandler(UIElement.PointerCaptureLostEvent, new PointerEventHandler(Seek_Released), true);
        SeekSlider.AddHandler(UIElement.PointerCanceledEvent, new PointerEventHandler(Seek_Canceled), true);
        seekTimer = DispatcherQueue.CreateTimer();
        seekTimer.Interval = TimeSpan.FromMilliseconds(250);
        seekTimer.IsRepeating = false;
        seekTimer.Tick += (_, _) => CommitSeek();
        music.Player.PlaybackSession.SeekCompleted += (_, _) => DispatcherQueue.TryEnqueue(() =>
        {
            if (closed || submittedSeek is not double target || Math.Abs(music.Player.PlaybackSession.Position.TotalSeconds - target) > 2) return;
            submittedSeek = null;
            PlaybackStatus.Text = music.Player.PlaybackSession.PlaybackState == MediaPlaybackState.Paused ? "已暂停" : "正在播放（FFmpeg）";
        });
        music.Player.MediaOpened += (sender, _) =>
        {
            var openedSource = sender.Source;
            DispatcherQueue.TryEnqueue(() =>
            { if (!closed && openedSource is not null && ReferenceEquals(music.Player.Source, openedSource)) { mediaReady = true; PlaybackStatus.Text = "正在播放（FFmpeg）"; } });
        };
        music.Player.MediaEnded += (sender, _) =>
        {
            var endedSource = sender.Source;
            DispatcherQueue.TryEnqueue(async () =>
            {
                if (closed || endedSource is null || !ReferenceEquals(music.Player.Source, endedSource)) return;
                var next = queue.Next(automatic: true);
                if (next is not null) await PlayTrackAsync(next);
                else { PlaybackStatus.Text = "队列播放结束"; mediaReady = false; music.Stop(); }
            });
        };
        music.Player.MediaFailed += (sender, args) =>
        {
            var failedSource = sender.Source;
            int code = args.ExtendedErrorCode?.HResult ?? 0;
            DispatcherQueue.TryEnqueue(() =>
            {
                if (closed || failedSource is null || !ReferenceEquals(music.Player.Source, failedSource)) return;
                mediaReady = false;
                PlaybackStatus.Text = $"FFmpeg 播放链路无法读取此音频（{code:X8}）。可尝试其他曲目。";
                music.Stop();
            });
        };
        progressTimer = DispatcherQueue.CreateTimer();
        progressTimer.Interval = TimeSpan.FromMilliseconds(500);
        progressTimer.Tick += (_, _) => UpdateProgress();
        progressTimer.Start();
    }
    private async Task ShowLibraryAsync()
    {
#if DEBUG
        if (IsSyntheticPreview) { await ShowSyntheticPreviewAsync(); return; }
#endif
        SettingsPanel.Visibility = Visibility.Collapsed;
        LibraryPanel.Visibility = Visibility.Visible;
        await LoadPageAsync(1);
        await LoadDevicesAsync();
    }
    private async void Library_Click(object sender, RoutedEventArgs e) => await ShowLibraryAsync();
    private void Settings_Click(object sender, RoutedEventArgs e)
    { LibraryPanel.Visibility = Visibility.Collapsed; SettingsPanel.Visibility = Visibility.Visible; }
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await LoadPageAsync(1);
    private async void Previous_Click(object sender, RoutedEventArgs e) => await LoadPageAsync(page - 1);
    private async void Next_Click(object sender, RoutedEventArgs e) => await LoadPageAsync(page + 1);
    private async void Search_Click(object sender, RoutedEventArgs e) => await SearchAsync();
    private async void Search_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != global::Windows.System.VirtualKey.Enter) return;
        e.Handled = true;
        await SearchAsync();
    }
    private async Task SearchAsync()
    {
        searchQuery = SearchInput.Text.Trim();
        await LoadPageAsync(1);
    }
    private async void ClearSearch_Click(object sender, RoutedEventArgs e)
    { SearchInput.Text = ""; searchQuery = ""; await LoadPageAsync(1); }

    private async Task LoadPageAsync(int requestedPage)
    {
        var api = ViewModel.AuthenticatedClient;
        if (api is null && !IsSyntheticPreview) { PlaybackStatus.Text = "请先在连接与账号中登录。"; return; }
        if (closed) return;
        libraryWork.Cancel(); libraryWork.Dispose(); libraryWork = new();
        var ct = libraryWork.Token;
        string query = searchQuery;
        page = 1; total = 0;
        PreviousPage.IsEnabled = NextPage.IsEnabled = false;
        TrackList.ItemsSource = null;
        PageStatus.Text = query.Length == 0 ? "正在加载曲库…" : "正在搜索…";
        try
        {
            TrackPage result;
#if DEBUG
            if (IsSyntheticPreview) result = await GetSyntheticPageAsync(query, Math.Max(1, requestedPage));
            else
#endif
            result = query.Length == 0
                ? await api!.ListTracksAsync(Math.Max(1, requestedPage), 50, ct)
                : await api!.SearchTracksAsync(query, Math.Max(1, requestedPage), 50, ct);
            if (ct.IsCancellationRequested || closed) return;
            page = Math.Max(1, requestedPage); total = result.Total;
            TrackList.ItemsSource = result.Tracks;
            TrackList.SelectedIndex = result.Tracks.Count > 0 ? 0 : -1;
            PageStatus.Text = $"{(query.Length == 0 ? "曲库" : "搜索结果")} · 第 {page} 页，共 {total} 首";
            if (result.Tracks.Count == 0) PageStatus.Text = query.Length == 0 ? "当前资料库暂无曲目。" : "没有找到匹配歌曲，可修改关键词重试。";
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (MusicApiException error) when (error.Failure == MusicFailure.Unauthorized)
        {
            if (!closed && !ct.IsCancellationRequested)
            { await ViewModel.ExpireSessionAsync(); PlaybackStatus.Text = "登录已失效，请在连接与账号中重新登录。"; }
        }
        catch (Exception) { if (!closed && !ct.IsCancellationRequested) PageStatus.Text = "加载失败，请检查网络后重新搜索或刷新。"; }
        finally
        {
            if (!closed && !ct.IsCancellationRequested) { PreviousPage.IsEnabled = page > 1; NextPage.IsEnabled = (long)page * 50 < total; }
        }
    }
    private async void PlaySelected_Click(object sender, RoutedEventArgs e)
    {
        if (TrackList.SelectedItem is not MusicTrack track) return;
        await StartQueueAsync(track);
    }
    private async void Track_DoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
    {
        if (sender is not FrameworkElement { DataContext: MusicTrack track }) return;
        e.Handled = true;
        TrackList.SelectedItem = track;
        await StartQueueAsync(track);
    }
    private async Task StartQueueAsync(MusicTrack track)
    {
        if (track.IsCue) { PlaybackStatus.Text = "CUE 分轨播放将在转码适配阶段接入。"; return; }
        if (TrackList.ItemsSource is not IEnumerable<MusicTrack> tracks || !queue.Replace(tracks, track.Id)) return;
        queueOrigin = searchQuery.Length == 0 ? "曲库当前页" : "搜索结果当前页";
        await PlayTrackAsync(track);
    }
    private async void PreviousTrack_Click(object sender, RoutedEventArgs e)
    { if (queue.Previous() is { } track) await PlayTrackAsync(track); }
    private async void NextTrack_Click(object sender, RoutedEventArgs e)
    { if (queue.Next(automatic: false) is { } track) await PlayTrackAsync(track); }
    private void QueueMode_Changed(object sender, SelectionChangedEventArgs e)
    { if (queue is not null && QueueModePicker.SelectedIndex is >= 0 and <= 3) queue.Mode = (QueueMode)QueueModePicker.SelectedIndex; }
    private async Task PlayTrackAsync(MusicTrack track)
    {
        if ((ViewModel.AuthenticatedClient is null && !IsSyntheticPreview) || closed) return;
        CancelWork(); music.Stop(); mediaReady = false;
        var ct = work.Token;
        UpdateQueueStatus();
        PlaybackStatus.Text = "正在加载音频…";
        try
        {
            var stream = await OpenPlaybackStreamAsync(track, ct);
            if (ct.IsCancellationRequested || closed) { stream.Dispose(); return; }
            NowPlaying.Text = track.Title + " · " + track.Artist;
            music.Open(stream, track.DurationSeconds);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (MusicApiException error) when (error.Failure == MusicFailure.Unauthorized)
        {
            if (!closed && !ct.IsCancellationRequested)
            { await ViewModel.ExpireSessionAsync(); PlaybackStatus.Text = "登录已失效，请在连接与账号中重新登录。"; }
        }
        catch (FileNotFoundException) { if (!closed && !ct.IsCancellationRequested) PlaybackStatus.Text = "未找到 FFmpeg。请安装 FFmpeg 并配置 PATH 后重新启动客户端。"; }
        catch (Exception) { if (!closed && !ct.IsCancellationRequested) PlaybackStatus.Text = "音频加载失败，请检查网络、登录状态或选择其他曲目。"; }
    }
    private void Pause_Click(object sender, RoutedEventArgs e) { music.Player.Pause(); if (mediaReady) PlaybackStatus.Text = "已暂停"; }
    private void UpdateQueueStatus() => QueueStatus.Text = queue.Count == 0 ? "播放队列为空" :
        queue.Current is null ? $"队列 {queue.Count} 首 · 未选择播放曲目" :
        $"队列 {queue.Index + 1}/{queue.Count} · 来自开始播放时的{queueOrigin}";
    private async void ManageQueue_Click(object sender, RoutedEventArgs e)
    {
        var list = new ListView { ItemsSource = queue.Tracks, DisplayMemberPath = "Title", SelectionMode = ListViewSelectionMode.Single, MaxHeight = 320 };
        list.SelectedItem = queue.Current;
        var remove = new Button { Content = "移除所选（当前曲目会停止）", IsEnabled = list.SelectedItem is MusicTrack };
        var clear = new Button { Content = "清空队列并停止", IsEnabled = queue.Count > 0 };
        var panel = new StackPanel { Spacing = 12 };
        panel.Children.Add(list); panel.Children.Add(remove); panel.Children.Add(clear);
        var dialog = new ContentDialog { XamlRoot = Root.XamlRoot, Title = "播放队列", Content = panel, PrimaryButtonText = "播放所选", CloseButtonText = "关闭", IsPrimaryButtonEnabled = list.SelectedItem is MusicTrack };
        list.SelectionChanged += (_, _) => remove.IsEnabled = dialog.IsPrimaryButtonEnabled = list.SelectedItem is MusicTrack;
        remove.Click += (_, _) =>
        {
            if (list.SelectedItem is not MusicTrack selected) return;
            if (queue.Current?.Id == selected.Id) Stop_Click(sender, e);
            queue.Remove(selected.Id);
            list.ItemsSource = queue.Tracks; list.SelectedItem = queue.Current;
            clear.IsEnabled = queue.Count > 0;
            UpdateQueueStatus();
        };
        clear.Click += (_, _) =>
        {
            Stop_Click(sender, e); queue.Clear(); list.ItemsSource = queue.Tracks;
            clear.IsEnabled = false;
            UpdateQueueStatus();
        };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary && list.SelectedItem is MusicTrack track && queue.Select(track.Id) is { } selectedTrack)
            await PlayTrackAsync(selectedTrack);
    }
    private void Resume_Click(object sender, RoutedEventArgs e) { if (mediaReady) { music.Player.Play(); PlaybackStatus.Text = "正在播放"; } }
    private void Stop_Click(object sender, RoutedEventArgs e) { CancelWork(); music.Stop(); mediaReady = false; PlaybackStatus.Text = "已停止"; NowPlaying.Text = ""; }
    private void Mute_Click(object sender, RoutedEventArgs e) => music.Player.IsMuted = MuteToggle.IsChecked == true;
    private void Volume_Changed(object sender, RangeBaseValueChangedEventArgs e) { if (music is not null) music.Player.Volume = e.NewValue / 100; }
    private void Seek_Changed(object sender, RangeBaseValueChangedEventArgs e)
    {
        if (updatingProgress || !mediaReady || !music.Player.PlaybackSession.CanSeek) return;
        pendingSeek = e.NewValue;
        PlaybackTime.Text = $"{TimeSpan.FromSeconds(e.NewValue):mm\\:ss} / {music.Player.PlaybackSession.NaturalDuration:mm\\:ss}";
        if (!draggingSeek) { seekTimer?.Stop(); seekTimer?.Start(); }
    }
    private void Seek_Pressed(object sender, PointerRoutedEventArgs e)
    { if (SeekSlider.IsEnabled) { draggingSeek = true; seekTimer?.Stop(); } }
    private void Seek_Released(object sender, PointerRoutedEventArgs e)
    { if (draggingSeek) { draggingSeek = false; CommitSeek(); } }
    private void Seek_Canceled(object sender, PointerRoutedEventArgs e) => ResetSeek();
    private void CommitSeek()
    {
        seekTimer?.Stop();
        if (draggingSeek || pendingSeek is not double target) return;
        pendingSeek = null;
        if (closed || !mediaReady || !music.Player.PlaybackSession.CanSeek) return;
        submittedSeek = target; seekDeadline = DateTimeOffset.UtcNow.AddSeconds(30);
        try
        {
            music.Player.PlaybackSession.Position = TimeSpan.FromSeconds(target);
            PlaybackStatus.Text = "正在跳转…";
        }
        catch (Exception) { submittedSeek = null; PlaybackStatus.Text = "跳转失败，请重试。"; }
    }
    private void ResetSeek()
    { draggingSeek = false; pendingSeek = submittedSeek = null; seekTimer?.Stop(); }
    private void UpdateProgress()
    {
        if (closed) return;
        var session = music.Player.PlaybackSession;
        double duration = session.NaturalDuration.TotalSeconds;
        if (submittedSeek is not null && DateTimeOffset.UtcNow >= seekDeadline)
        { submittedSeek = null; PlaybackStatus.Text = "跳转等待超时，可重试或重新播放。"; }
        updatingProgress = true;
        try
        {
            SeekSlider.Maximum = Math.Max(1, duration);
            SeekSlider.IsEnabled = mediaReady && duration > 0 && session.CanSeek;
            if (!draggingSeek && pendingSeek is null && submittedSeek is null)
            {
                SeekSlider.Value = Math.Clamp(session.Position.TotalSeconds, 0, SeekSlider.Maximum);
                PlaybackTime.Text = $"{session.Position:mm\\:ss} / {session.NaturalDuration:mm\\:ss}";
            }
        }
        finally { updatingProgress = false; }
    }
    private async void Devices_Click(object sender, RoutedEventArgs e) => await LoadDevicesAsync();
    private async Task LoadDevicesAsync()
    {
        try
        {
            var selectedId = music.Player.AudioDevice?.Id;
            var devices = await DeviceInformation.FindAllAsync(MediaDevice.GetAudioRenderSelector());
            if (closed) return;
            var options = new List<OutputOption> { new("系统默认设备", null) };
            options.AddRange(devices.Select(d => new OutputOption(d.Name, d)));
            OutputDevices.ItemsSource = options;
            OutputDevices.SelectedItem = options.FirstOrDefault(o => o.Device?.Id == selectedId) ?? options[0];
        }
        catch (Exception) { if (!closed) PlaybackStatus.Text = "无法枚举音频设备，请检查设备连接后重试。"; }
    }
    private void Output_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (OutputDevices.SelectedItem is not OutputOption option) return;
        try { music.Player.AudioDevice = option.Device; }
        catch (Exception) { PlaybackStatus.Text = "无法切换音频设备，请刷新设备列表。"; }
    }
    private void CancelWork() { ResetSeek(); work.Cancel(); work.Dispose(); work = new(); }
    private void ResetLibrary()
    {
        CancelWork(); music.Stop(); mediaReady = false;
        libraryWork.Cancel();
        searchQuery = ""; SearchInput.Text = "";
        TrackList.ItemsSource = null; NowPlaying.Text = PageStatus.Text = "";
        queue.Clear(); QueueStatus.Text = "播放队列为空";
        page = 1; total = 0; PreviousPage.IsEnabled = NextPage.IsEnabled = false;
        PlaybackStatus.Text = "登录后刷新曲库。";
    }
    private void ClosePlayback()
    { closed = true; ResetSeek(); progressTimer?.Stop(); libraryWork.Cancel(); libraryWork.Dispose(); work.Cancel(); work.Dispose(); music.Dispose(); }
}
