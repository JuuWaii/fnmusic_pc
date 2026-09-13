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
    private DispatcherQueueTimer? progressTimer;
    private DispatcherQueueTimer? seekTimer;
    private bool draggingSeek;
    private double? pendingSeek, submittedSeek;
    private DateTimeOffset seekDeadline;
    private int page = 1, total;
    private bool loading, updatingProgress, closed, mediaReady;
    private sealed record OutputOption(string Name, DeviceInformation? Device);

    private void InitializePlayback()
    {
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

    private async Task LoadPageAsync(int requestedPage)
    {
        var api = ViewModel.AuthenticatedClient;
        if (api is null) { PlaybackStatus.Text = "请先在连接与账号中登录。"; return; }
        if (loading || closed) return;
        var ct = work.Token;
        loading = true; PreviousPage.IsEnabled = NextPage.IsEnabled = false;
        try
        {
            var result = await api.ListTracksAsync(Math.Max(1, requestedPage), 50, ct);
            if (ct.IsCancellationRequested || closed) return;
            page = Math.Max(1, requestedPage); total = result.Total;
            TrackList.ItemsSource = result.Tracks;
            TrackList.SelectedIndex = result.Tracks.Count > 0 ? 0 : -1;
            PageStatus.Text = $"第 {page} 页，共 {total} 首";
            PlaybackStatus.Text = result.Tracks.Count == 0 ? "当前资料库暂无曲目。" : "曲库已加载，选择曲目后播放。";
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (MusicApiException error) when (error.Failure == MusicFailure.Unauthorized)
        {
            if (!closed && !ct.IsCancellationRequested)
            { await ViewModel.ExpireSessionAsync(); PlaybackStatus.Text = "登录已失效，请在连接与账号中重新登录。"; }
        }
        catch (Exception) { if (!closed && !ct.IsCancellationRequested) PlaybackStatus.Text = "曲库加载失败，请检查网络和登录状态后刷新。"; }
        finally
        {
            loading = false;
            if (!closed) { PreviousPage.IsEnabled = page > 1; NextPage.IsEnabled = (long)page * 50 < total; }
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
        QueueStatus.Text = $"队列 {queue.Index + 1}/{queue.Count} · 来自开始播放时的当前页";
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
        TrackList.ItemsSource = null; NowPlaying.Text = PageStatus.Text = "";
        queue.Clear(); QueueStatus.Text = "播放队列为空";
        page = 1; total = 0; PreviousPage.IsEnabled = NextPage.IsEnabled = false;
        PlaybackStatus.Text = "登录后刷新曲库。";
    }
    private void ClosePlayback()
    { closed = true; ResetSeek(); progressTimer?.Stop(); work.Cancel(); work.Dispose(); music.Dispose(); }
}
