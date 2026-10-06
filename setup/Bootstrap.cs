using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--verify-only")
        {
            try { return RunBootstrap(true, Console.WriteLine); }
            catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        }
        if (args.Length != 0) return 2;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupWindow());
        return 0;
    }

    internal static int RunBootstrap(bool downloadOnly, Action<string> log)
    {
        var folder = Path.Combine(Path.GetTempPath(), "visave-launcher-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        var script = Path.Combine(folder, "install.ps1");
        using (var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("visave.install.ps1"))
        using (var target = File.Create(script))
        {
            if (source == null) throw new InvalidOperationException("The installer resource is missing. Download a fresh release.");
            source.CopyTo(target);
        }
        // Ship the reviewed script inside the executable rather than fetching executable code at runtime.
        var shell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        var options = new ProcessStartInfo(shell, "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -NoOpenGuide" + (downloadOnly ? " -DownloadOnly" : ""));
        options.UseShellExecute = false;
        options.CreateNoWindow = true;
        options.RedirectStandardOutput = true;
        options.RedirectStandardError = true;
        options.EnvironmentVariables.Remove("PSModulePath");
        using (var process = new Process())
        {
            process.StartInfo = options;
            process.OutputDataReceived += (sender, line) => { if (line.Data != null) log(line.Data); };
            process.ErrorDataReceived += (sender, line) => { if (line.Data != null) log(line.Data); };
            if (!process.Start()) throw new InvalidOperationException("Windows could not start the setup process.");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            process.WaitForExit();
            return process.ExitCode;
        }
    }
}

internal sealed class SetupWindow : Form
{
    private readonly Button install = new Button();
    private readonly Label status = new Label();
    private readonly TextBox details = new TextBox();
    private bool running;
    private bool complete;

    internal SetupWindow()
    {
        Text = "visave setup";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(600, 420);
        MinimumSize = new Size(540, 440);
        Font = SystemFonts.MessageBoxFont;
        var title = new Label { Text = "Install visave download components", AutoSize = true, Location = new Point(20, 20), Font = new Font(Font.FontFamily, 15, FontStyle.Bold) };
        var description = new Label { Text = "Installs private Python, yt-dlp, Node.js and video tools for your Windows user.\r\nDownloads verified files from GitHub and the FFmpeg publisher.\r\nInternet access is required. No administrator access or startup service is needed.", Location = new Point(20, 58), Size = new Size(560, 64), Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right };
        status.Text = "Click Install to begin.";
        status.SetBounds(20, 130, 560, 38);
        status.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        status.AccessibleName = "Installation status";
        details.SetBounds(20, 174, 560, 181);
        details.Multiline = true;
        details.ReadOnly = true;
        details.ScrollBars = ScrollBars.Vertical;
        details.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        details.AccessibleName = "Setup details";
        install.Text = "Install";
        install.SetBounds(460, 371, 120, 30);
        install.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
        install.Click += async (sender, args) => await Install();
        var credit = new LinkLabel { Text = "made by senzdev", AutoSize = true, Location = new Point(20, 379), Anchor = AnchorStyles.Bottom | AnchorStyles.Left };
        credit.LinkClicked += (sender, args) => Process.Start(new ProcessStartInfo("https://github.com/senzore") { UseShellExecute = true });
        Controls.AddRange(new Control[] { title, description, status, details, install, credit });
        AcceptButton = install;
        FormClosing += (sender, args) => {
            if (running) { args.Cancel = true; MessageBox.Show(this, "Wait for setup to finish before closing this window.", "Setup is running", MessageBoxButtons.OK, MessageBoxIcon.Information); }
        };
    }

    private async Task Install()
    {
        if (complete) { Close(); return; }
        if (running) return;
        running = true;
        install.Enabled = false;
        status.Text = "Downloading, verifying and testing components. This can take several minutes.";
        details.Clear();
        try
        {
            var code = await Task.Run(() => Program.RunBootstrap(false, line => BeginInvoke((Action)(() => details.AppendText(line + Environment.NewLine)))));
            complete = code == 0;
            status.Text = complete ? "Installation complete. Return to visave in Firefox; downloads unlock after its check." : "Setup failed. Read the details below. You can retry after fixing the problem.";
            install.Text = complete ? "Finish" : "Retry";
        }
        catch (Exception error) { status.Text = "Setup failed: " + error.Message; install.Text = "Retry"; }
        finally { running = false; install.Enabled = true; }
    }
}
