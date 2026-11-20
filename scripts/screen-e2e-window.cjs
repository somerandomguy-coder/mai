// Helper for screen-e2e.ts: covers the whole screen with a page of known text (so the test never reads his real
// screen), prints "READY", and stays up until killed.
const { app, BrowserWindow, screen } = require("electron");

const page = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#fff;font:26px 'Segoe UI';color:#222">
<div style="height:40px;background:#2b2b2b;color:#ddd;font:14px 'Segoe UI';display:flex;align-items:center;padding-left:16px">Notepad - task-toi-nay.txt</div>
<div style="padding:60px 90px;line-height:1.8">
<div>Task tối nay</div>
<div>- Cảm ơn anh David vì đã giới thiệu mình với team bên Lyra</div>
<div>- Gửi lại file CV đã sửa cho anh Phong</div>
<div>- Xem hết video Git &amp; GitHub, ghi chú phần rebase</div>
<div>- Nhắn tin cho mẹ trước 10 giờ tối</div>
<div>Mã phòng họp: XK-4821</div>
</div></body>`;

app.whenReady().then(() => {
	const { bounds } = screen.getPrimaryDisplay();
	const win = new BrowserWindow({ ...bounds, frame: false, alwaysOnTop: true, skipTaskbar: true, show: false });
	win.setAlwaysOnTop(true, "screen-saver");
	win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
	win.once("ready-to-show", () => {
		win.show();
		win.focus();
		setTimeout(() => console.log("READY"), 800);
	});
});
