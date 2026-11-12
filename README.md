# workspace (IDE-skinned dcinside client)

An Electron app that loads the real `gall.dcinside.com` PC site inside an IntelliJ-style window.
Because it is the real site, everything works as usual: login, writing posts, image/video upload, comments, recommend.

## Run

```
npm install
npm start
```

On Windows you can also just double-click `dcideexe.bat` (it installs dependencies on first run).

## What looks like what

| IDE element | dcinside |
|---|---|
| Editor tabs (`ProgrammingRepository.java`, `…Entity1234.java`, `…Command.java`) | gallery list / post / write page |
| Project tree › `com.workspace.modules` | galleries you added with **+** (`findAll()` = list, `findRecommended()` = 개념글, `save()` = 글쓰기) |
| `com.workspace.cache` | recently visited galleries (hover: ✕ removes one, 🗑 on the folder clears all; modules are kept) |
| Bookmarks (★ stripe) | saved posts |
| Address bar ("Search Everywhere") | URL, gallery id (e.g. `programming`), or search keyword |
| Notifications (🔔 stripe, bottom panel, balloon) | dcinside's own comment/reply alarms on your posts |

The real gallery name only appears as a hover tooltip.

### Gallery list = Git Log
The list page is restyled as IntelliJ's Git › Log window: commit graph dots, title = commit message,
comment count = `(#N)`, image/video posts = `assets`/`media` ref labels, author, `Today 14:39`-style date,
and the post number shown as a fake 7-char commit hash (real number on hover).
Views/recommend columns, IPs, nick icons, notice/AD/survey rows and the right-side widgets are hidden
(notices still appear on the **Pinned** tab). Tabs: All commits = 전체글, Starred = 개념글, Pinned = 공지, Commit… = 글쓰기.

### Post view = commit details + code review
- Header: `commit <hash>  origin/<gallery>`, title as commit subject, `Author:` / `Date:` with an avatar,
  stats as `+183` (views) · `★ 0` (recommend) · `12 comments`.
- Body sits in a `CHANGELOG.md` file panel.
- 추천 / 비추천 → **✓ Approve** / **✗ Request changes** (same buttons, same counts).
- Comments → review threads with avatars; replies are indented. Input box says "Leave a review comment…",
  buttons: Comment / Comment & approve / Emoji(디시콘) / Snippets(글자콘).
- IPs, nick icons, 실베추/펌/공유/스크랩/신고 row and ads are hidden. Hover any renamed label to see the original.

### Login = "GitLab 계정 로그인" dialog
The app **starts on this dialog**; after a successful login it goes straight to your own gallog
(the gallog URL is remembered from the account box once you are logged in). Cancel/✕ goes to the main page.
Open it from the project tree: **External Libraries › Auth: session-config** (or the login box on the right).
- 사용자 = dcinside 식별 코드(아이디), 토큰 = 비밀번호
- 사용자 이름 기억 = 식별 코드 저장, 생성... = 비밀번호 찾기, 취소/✕ = 원래 페이지로 돌아가기
The real form fields and submit button are reused, so login works exactly as on the site.

### Account box & gallog (profile)
- Right-side login box → "GitLab · gitlab.workspace.dev" panel with avatar; 갤로그 = Profile, 즐겨찾기 = Favorites,
  운영 = Admin, 스크랩 = Stash, 알림 = Notifications, 로그아웃 = Log out.
- Gallog → profile/activity view: initials avatar instead of the mascot, `@id · gitlab.workspace.dev`,
  menu 홈/게시물/댓글/스크랩/방명록 = Overview/Commits/Review comments/Stash/Discussions.
  Top link bar, visitor counter and calendar are hidden.

## Notifications
dcinside's PC page polls its alarm API every ~60s and shows a pop-up. The app hides that pop-up and re-shows it as an IDE balloon + Notifications log entry (and optionally a Windows toast saying "Build completed").
It needs: logged in, at least one tab open, and dcinside's alarm setting turned on.

## Shortcuts
- **Shift Shift** or **Ctrl+N** (or the magnifier in the title bar): Search Everywhere = gallery search.
  Enter opens, Ctrl+Enter opens in a new tab, Alt+Enter adds it to the project tree (modules). Last row = full-text search.
- **Ctrl+Shift+F12** (global) or **Esc Esc**: boss mode → fake `OrderService.java`, all audio muted, balloons suppressed
- Ctrl+T / Ctrl+W / Ctrl+Tab: new / close / next tab
- Ctrl+L: address bar · Alt+←/→: back/forward · F5: reload · Alt+1: toggle project panel

## Settings (⚙ bottom-left)
- Dim images & videos until hover (default on)
- Switch to code view when the window loses focus
- Windows toast for notifications
- Mute page audio (default on)

## Files
- `main.js` – window, webview security, UA, global boss key
- `renderer/` – IDE shell (tabs, tree, notifications, boss mode)
- `webview-preload.js` – runs in the dcinside page: injects skin, forwards alarms and shortcuts
- `skin/dc-skin.css` – the Darcula skin for dcinside pages (edit this if the site layout changes)

Data (login cookies, settings) is stored in `%APPDATA%\workspace-ide`.
