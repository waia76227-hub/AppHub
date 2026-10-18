using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
    private const string AppTitle = "应用集合";

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    private static Mutex instanceMutex;

    [STAThread]
    static void Main()
    {
        string appDir = AppContext.BaseDirectory;
        Directory.CreateDirectory(Path.Combine(appDir, "data"));

        try
        {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
        }
        catch
        {
            try { SetProcessDPIAware(); } catch { }
        }

        bool createdNew;
        instanceMutex = new Mutex(true, "AppHub.Launcher.SingleInstance", out createdNew);
        if (!createdNew)
        {
            IntPtr existing = FindWindow(null, AppTitle);
            if (existing != IntPtr.Zero)
            {
                ShowWindow(existing, 9);
                SetForegroundWindow(existing);
            }
            return;
        }

        SetCurrentProcessExplicitAppUserModelID("AppHub.Launcher");

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
        {
            ShowError(appDir, e.Exception);
        };
        AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
        {
            WriteLog(appDir, "FATAL " + e.ExceptionObject);
        };

        try
        {
            Application.Run(new MainForm(appDir));
        }
        finally
        {
            if (instanceMutex != null)
            {
                try { instanceMutex.ReleaseMutex(); } catch { }
            }
        }
    }

    internal static void WriteLog(string appDir, string message)
    {
        try
        {
            File.AppendAllText(
                Path.Combine(appDir, "data", "desktop.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + message + Environment.NewLine,
                Encoding.UTF8);
        }
        catch { }
    }

    internal static void ShowError(string appDir, Exception error)
    {
        WriteLog(appDir, "ERROR " + error);
        string logPath = Path.Combine(appDir, "data", "desktop.log");
        MessageBox.Show(
            AppTitle + " 启动失败：\n\n" + error.Message + "\n\n详细日志：" + logPath,
            AppTitle,
            MessageBoxButtons.OK,
            MessageBoxIcon.Error);
    }
}

sealed class MainForm : Form
{
    private readonly string appDir;
    private WebView2 web;
    private Label loading;
    private Process serverProcess;
    private int port;
    private bool fullscreen;
    private Rectangle previousBounds;
    private FormBorderStyle previousBorder;
    private FormWindowState previousState;

    public MainForm(string appDir)
    {
        this.appDir = appDir;
        Text = "应用集合";
        Width = 1340;
        Height = 880;
        MinimumSize = new Size(900, 620);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(13, 18, 32);
        AutoScaleMode = AutoScaleMode.Dpi;
        WindowState = FormWindowState.Maximized;
        KeyPreview = true;

        string iconPath = Path.Combine(appDir, "assets", "apphub.ico");
        if (File.Exists(iconPath))
        {
            try { Icon = new Icon(iconPath); } catch { }
        }

        loading = new Label();
        loading.Text = "正在打开应用集合…";
        loading.ForeColor = Color.FromArgb(210, 220, 245);
        loading.BackColor = Color.Transparent;
        loading.Font = new Font("Microsoft YaHei UI", 12f);
        loading.AutoSize = true;
        Controls.Add(loading);
        CenterLoading();

        Shown += async delegate { await StartAsync(); };
        Resize += delegate { CenterLoading(); };
        FormClosing += delegate { StopServer(); };
        KeyDown += delegate(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.F11)
            {
                ToggleFullscreen();
                e.Handled = true;
                e.SuppressKeyPress = true;
            }
        };
    }

    private void CenterLoading()
    {
        if (loading != null)
        {
            loading.Location = new Point(
                Math.Max(0, (ClientSize.Width - loading.PreferredWidth) / 2),
                Math.Max(0, (ClientSize.Height - loading.PreferredHeight) / 2));
            loading.BringToFront();
        }
    }

    private async Task StartAsync()
    {
        try
        {
            port = GetFreePort();
            StartServer(port);
            await WaitForServer(port);
            await StartWebView(port);
        }
        catch (Exception error)
        {
            Program.WriteLog(appDir, "ERROR " + error);
            MessageBox.Show(
                "应用集合启动失败：\n\n" + error.Message + "\n\n日志：" + Path.Combine(appDir, "data", "desktop.log"),
                "应用集合",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private int GetFreePort()
    {
        TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int freePort = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return freePort;
    }

    private string ResolveNode()
    {
        string[] candidates = new string[]
        {
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe"
        };
        foreach (string candidate in candidates)
        {
            if (File.Exists(candidate)) return candidate;
        }
        string pathVariable = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string folder in pathVariable.Split(';'))
        {
            try
            {
                string candidate = Path.Combine(folder.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }
        throw new Exception("未找到 Node.js，请先安装 Node.js（https://nodejs.org）。");
    }

    private void StartServer(int serverPort)
    {
        string serverJs = Path.Combine(appDir, "server", "server.js");
        if (!File.Exists(serverJs))
        {
            throw new Exception("缺少 server\\server.js，请保持文件夹结构完整。");
        }

        ProcessStartInfo info = new ProcessStartInfo(ResolveNode(), "\"" + serverJs + "\"");
        info.WorkingDirectory = appDir;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.StandardOutputEncoding = Encoding.UTF8;
        info.StandardErrorEncoding = Encoding.UTF8;
        info.EnvironmentVariables["APPHUB_PORT"] = serverPort.ToString();

        serverProcess = new Process();
        serverProcess.StartInfo = info;
        serverProcess.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (!string.IsNullOrEmpty(e.Data)) Program.WriteLog(appDir, "OUT " + e.Data);
        };
        serverProcess.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (!string.IsNullOrEmpty(e.Data)) Program.WriteLog(appDir, "ERR " + e.Data);
        };
        serverProcess.Start();
        serverProcess.BeginOutputReadLine();
        serverProcess.BeginErrorReadLine();
        Program.WriteLog(appDir, "server started on port " + serverPort + " pid " + serverProcess.Id);
    }

    private async Task WaitForServer(int serverPort)
    {
        for (int attempt = 0; attempt < 120; attempt++)
        {
            if (serverProcess.HasExited)
            {
                throw new Exception("后台服务已退出（退出码 " + serverProcess.ExitCode + "）。");
            }
            if (await IsServerReady(serverPort)) return;
            await Task.Delay(200);
        }
        throw new Exception("等待后台服务超时。");
    }

    private static async Task<bool> IsServerReady(int serverPort)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + serverPort + "/api/status");
            request.Timeout = 800;
            request.Proxy = null;
            using (HttpWebResponse response = (HttpWebResponse)await request.GetResponseAsync())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                string body = await reader.ReadToEndAsync();
                return body.Contains("\"app\":\"apphub\"");
            }
        }
        catch
        {
            return false;
        }
    }

    private async Task StartWebView(int serverPort)
    {
        string userData = ResolveWebViewDataFolder();
        bool success = await TryStartWebView(serverPort, userData, null);

        if (!success)
        {
            Program.WriteLog(appDir, "webview retry in compatibility mode");
            try
            {
                if (web != null)
                {
                    Controls.Remove(web);
                    web.Dispose();
                    web = null;
                }
            }
            catch { }
            await Task.Delay(500);
            success = await TryStartWebView(
                serverPort,
                userData,
                new CoreWebView2EnvironmentOptions("--no-sandbox --disable-gpu"));
        }

        if (!success)
        {
            throw new Exception("WebView2 页面加载失败，请确认系统已安装 Microsoft Edge WebView2 运行时。");
        }
        loading.Visible = false;
        Program.WriteLog(appDir, "webview ready");
    }

    private string ResolveWebViewDataFolder()
    {
        string[] candidates = new string[]
        {
            Path.Combine(appDir, "data", "webview"),
            Path.Combine(Path.GetTempPath(), "AppHub", "WebView2")
        };
        foreach (string candidate in candidates)
        {
            try
            {
                Directory.CreateDirectory(candidate);
                return candidate;
            }
            catch { }
        }
        throw new Exception("找不到可写的 WebView2 缓存目录。");
    }

    private async Task<bool> TryStartWebView(
        int serverPort,
        string userData,
        CoreWebView2EnvironmentOptions options)
    {
        WebView2 control = new WebView2();
        control.Dock = DockStyle.Fill;
        control.Visible = false;
        try { control.DefaultBackgroundColor = Color.FromArgb(13, 18, 32); } catch { }
        Controls.Add(control);
        control.BringToFront();
        web = control;
        loading.Visible = true;

        try
        {
            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userData, options);
            await control.EnsureCoreWebView2Async(environment);

            CoreWebView2Settings settings = control.CoreWebView2.Settings;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreDevToolsEnabled = false;
            settings.IsStatusBarEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = false;
            settings.IsZoomControlEnabled = true;

            control.CoreWebView2.WebMessageReceived += delegate(
                object messageSender,
                CoreWebView2WebMessageReceivedEventArgs messageArgs)
            {
                string message = null;
                try { message = messageArgs.TryGetWebMessageAsString(); } catch { }
                if (message == "toggle-fullscreen")
                {
                    ToggleFullscreen();
                }
            };

            control.CoreWebView2.DocumentTitleChanged += delegate
            {
                if (!string.IsNullOrWhiteSpace(control.CoreWebView2.DocumentTitle))
                {
                    Text = control.CoreWebView2.DocumentTitle;
                }
            };
            control.CoreWebView2.NewWindowRequested += delegate(
                object sender,
                CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
            };

            TaskCompletionSource<bool> completed = new TaskCompletionSource<bool>();
            control.CoreWebView2.NavigationCompleted += delegate(
                object sender,
                CoreWebView2NavigationCompletedEventArgs e)
            {
                Program.WriteLog(
                    appDir,
                    "navigation completed success=" + e.IsSuccess + " status=" + e.WebErrorStatus);
                if (!completed.Task.IsCompleted)
                {
                    completed.TrySetResult(e.IsSuccess);
                }
            };

            control.Visible = true;
            control.Source = new Uri("http://127.0.0.1:" + serverPort + "/");

            Task finished = await Task.WhenAny(completed.Task, Task.Delay(12000));
            if (finished != completed.Task || !completed.Task.Result)
            {
                return false;
            }

            try
            {
                string check = await control.CoreWebView2.ExecuteScriptAsync(
                    "JSON.stringify({title: document.title, tiles: document.querySelectorAll('.tile').length})");
                Program.WriteLog(appDir, "page check " + check);
            }
            catch (Exception checkError)
            {
                Program.WriteLog(appDir, "page check failed " + checkError.Message);
            }
            return true;
        }
        catch (Exception error)
        {
            Program.WriteLog(appDir, "webview attempt failed " + error.Message);
            return false;
        }
    }

    private void StopServer()
    {
        if (serverProcess == null || serverProcess.HasExited) return;
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(
                "taskkill.exe",
                "/PID " + serverProcess.Id + " /T /F");
            info.CreateNoWindow = true;
            info.UseShellExecute = false;
            Process.Start(info);
        }
        catch
        {
            try { serverProcess.Kill(); } catch { }
        }
    }

    private void ToggleFullscreen()
    {
        if (!fullscreen)
        {
            previousBounds = Bounds;
            previousBorder = FormBorderStyle;
            previousState = WindowState;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Normal;
            Bounds = Screen.FromControl(this).Bounds;
            fullscreen = true;
        }
        else
        {
            FormBorderStyle = previousBorder;
            Bounds = previousBounds;
            WindowState = previousState;
            fullscreen = false;
        }
    }
}
