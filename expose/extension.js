/**
 * Exposé (Tahoe) — macOS-style Exposé / Mission Control for GNOME Shell (46+).
 *
 * Two modes, mirroring macOS:
 *   - "all": every window on the active workspace scales down and tiles so they
 *            all fit on screen, keeping their relative layout.
 *   - "app" (App Exposé): only the focused application's windows (including
 *            minimized ones) are shown; Tab cycles through the other apps.
 *
 * Behaviour: click a window to focus it, click the empty background (or Esc)
 * to dismiss, arrow keys move the highlight and Enter activates. Windows keep
 * their live content (Clutter.Clone of the compositor actor), and the desktop
 * is blurred + dimmed behind them.
 */

import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const KEYBIND_ALL = 'keybinding-all-windows';
const KEYBIND_APP = 'keybinding-app-expose';

// Logical px between a window preview's live content and its rounded frame.
const FRAME_INSET = 2;
// Longest title shown under a preview before it is truncated.
const TITLE_MAX = 42;
// Logical px reserved for the title pill at the bottom of a preview.
const TITLE_H = 26;


function _isNormal(win) {
    if (!win) return false;
    if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
    if (win.skip_taskbar || win.is_attached_dialog()) return false;
    if (win.is_always_on_all_workspaces()) return false;
    return true;
}

/** Primary monitor geometry (physical px). Never returns null. */
function _getMon() {
    const display = global.display;
    const primary = display.get_primary_monitor();
    const index = primary >= 0 ? primary : 0;

    if (display.get_n_monitors() > index) {
        const rect = display.get_monitor_geometry(index);
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, index };
    }
    return Main.layoutManager.primaryMonitor ??
           { x: 0, y: 0, width: 1920, height: 1080, index: 0 };
}


class Expose {
    constructor(settings) {
        this._settings = settings;
        this._sigSources = new Set();

        this._overlay = null;
        this._dim = null;
        this._blur = null;
        this._previews = [];   // { win, frame, clone, title, orig, target }
        this._grab = null;

        this._mode = null;     // null | 'all' | 'app'
        this._appId = null;    // app currently shown in 'app' mode
        this._focused = 0;

        this._scaleFactor = 1;
        this._themeClass = '';
        this._keybindings = [];
    }

    // ── Settings / state ────────────────────────────────────────────────

    get _active() { return this._overlay !== null; }
    get _ANIM_MS() {
        return St.Settings.get().enable_animations === false
            ? 0
            : this._settings.get_int('animation-duration');
    }

    _cls(...names) {
        const n = names.filter(Boolean);
        return this._themeClass ? [...n, this._themeClass].join(' ') : n.join(' ');
    }

    _recomputeThemeClass() {
        const cs = St.Settings.get().color_scheme;
        this._themeClass = (cs === St.SystemColorScheme.PREFER_LIGHT) ? 'light' : '';
    }

    _sig(obj, signal, cb) {
        obj.connectObject(signal, cb, this);
        this._sigSources.add(obj);
    }

    // ── Lifecycle ───────────────────────────────────────────────────────

    enable() {
        this._scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        this._recomputeThemeClass();
        this._addKeybindings();

        this._sig(global.workspace_manager, 'active-workspace-changed', () => this._close());
        this._sig(global.display, 'in-fullscreen-changed', () => this._close());
        this._sig(Main.layoutManager, 'monitors-changed', () => this._close());
        this._sig(St.Settings.get(), 'notify::color-scheme', () => this._recomputeThemeClass());
    }

    disable() {
        this._removeKeybindings();
        this._close();
        this._sigSources.forEach(o => o.disconnectObject(this));
        this._sigSources.clear();
    }

    _addKeybindings() {
        this._removeKeybindings();
        const bindings = [
            [KEYBIND_ALL, () => this._toggle('all')],
            [KEYBIND_APP, () => this._toggle('app')],
        ];
        for (const [name, cb] of bindings) {
            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                cb,
            );
            this._keybindings.push(name);
        }
    }

    _removeKeybindings() {
        this._keybindings.forEach(name => Main.wm.removeKeybinding(name));
        this._keybindings = [];
    }

    _toggle(mode) {
        if (this._active && this._mode === mode) {
            this._close();
            return;
        }
        this._open(mode);
    }

    // ── Collect windows ─────────────────────────────────────────────────

    _collectWindows() {
        const ws = global.workspace_manager.get_active_workspace();
        const all = ws.list_windows().filter(w => _isNormal(w));

        if (this._mode === 'app') {
            const tracker = Shell.WindowTracker.get_default();
            const id = this._appId;
            if (!id) return [];
            return all.filter(w => {
                const app = tracker.get_window_app(w);
                return app && app.get_id() === id;
            });
        }
        // "all" shows unhidden windows; minimized ones live in the dock.
        return all.filter(w => !w.minimized);
    }

    // ── Layout: shrink in place, preserving relative positions ─────────

    _layout(wins) {
        const mon = _getMon();
        const wa = Main.layoutManager.getWorkAreaForMonitor(mon.index);
        const sf = this._scaleFactor;
        const pad = Math.round(56 * sf);

        // Minimized windows get a fixed-size row at the bottom (their frame
        // rect is parked off-screen, so it can't be used for the tile layout).
        const visible = wins.filter(w => !w.minimized);
        const minimized = wins.filter(w => w.minimized);
        const reservedH = minimized.length > 0
            ? Math.round(120 * sf) + Math.round(24 * sf)
            : 0;

        const out = [];
        if (visible.length > 0) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            const rects = new Map();
            for (const w of visible) {
                const r = w.get_frame_rect();
                rects.set(w, r);
                minX = Math.min(minX, r.x);
                minY = Math.min(minY, r.y);
                maxX = Math.max(maxX, r.x + r.width);
                maxY = Math.max(maxY, r.y + r.height);
            }

            const bboxW = Math.max(1, maxX - minX);
            const bboxH = Math.max(1, maxY - minY);
            const availW = Math.max(1, wa.width - pad * 2);
            const availH = Math.max(1, wa.height - pad * 2 - reservedH);

            let scale = Math.min(availW / bboxW, availH / bboxH);
            scale = Math.max(
                this._settings.get_int('min-scale') / 100,
                Math.min(this._settings.get_int('max-scale') / 100, scale));

            const scaledW = bboxW * scale;
            const scaledH = bboxH * scale;
            const offX = wa.x + (wa.width - scaledW) / 2;
            const offY = wa.y + (wa.height - reservedH - scaledH) / 2;

            for (const w of visible) {
                const r = rects.get(w);
                out.push({
                    win: w,
                    orig: { x: r.x, y: r.y, w: r.width, h: r.height },
                    target: {
                        x: offX + (r.x - minX) * scale,
                        y: offY + (r.y - minY) * scale,
                        w: r.width * scale,
                        h: r.height * scale,
                    },
                });
            }
        }

        if (minimized.length > 0) {
            const mw = Math.round(180 * sf);
            const mh = Math.round(112 * sf);
            const gap = Math.round(16 * sf);
            minimized.sort((a, b) => (b.get_user_time() || 0) - (a.get_user_time() || 0));
            const totalW = minimized.length * mw + (minimized.length - 1) * gap;
            let x = wa.x + (wa.width - totalW) / 2;
            const y = wa.y + wa.height - mh - Math.round(24 * sf);
            for (const w of minimized) {
                out.push({
                    win: w,
                    orig: { x, y, w: mw, h: mh },
                    target: { x, y, w: mw, h: mh },
                });
                x += mw + gap;
            }
        }

        return out;
    }

    // ── Open / close ────────────────────────────────────────────────────

    _open(mode) {
        if (this._active) this._close();

        this._mode = mode;
        this._appId = null;
        if (mode === 'app') {
            const focused = global.display.get_focus_window();
            const app = focused
                ? Shell.WindowTracker.get_default().get_window_app(focused)
                : null;
            this._appId = app ? app.get_id() : null;
        }

        const wins = this._collectWindows();
        if (wins.length === 0) {
            this._mode = null;
            this._appId = null;
            return;
        }

        const sw = global.screen_width;
        const sh = global.screen_height;

        this._overlay = new St.Widget({
            reactive: true,
            clip_to_allocation: false,
            style: 'background-color: transparent;',
        });
        this._overlay.set_position(0, 0);
        this._overlay.set_size(sw, sh);

        this._addBlurBackdrop(sw, sh);

        const dimAmount = this._settings.get_double('dim-amount');
        this._dim = new St.Widget({
            reactive: false,
            style: `background-color: rgba(0, 0, 0, ${dimAmount.toFixed(3)});`,
        });
        this._dim.set_position(0, 0);
        this._dim.set_size(sw, sh);
        this._overlay.add_child(this._dim);

        const layout = this._layout(wins);
        for (const item of layout) this._makePreview(item, true);

        Main.uiGroup.add_child(this._overlay);
        Main.uiGroup.set_child_above_sibling(this._overlay, null);

        this._sig(this._overlay, 'button-release-event', (_a, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            const pv = this._previewAtPointer();
            if (pv) this._activateWindow(pv.win);
            else this._close();
            return Clutter.EVENT_STOP;
        });
        this._sig(this._overlay, 'key-press-event', (_a, event) => this._onKeyPress(event));

        this._grab = Main.pushModal(this._overlay);

        this._overlay.opacity = 0;
        this._overlay.ease({
            opacity: 255,
            duration: this._ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._focused = 0;
        this._updateFocusHighlight();
    }

    _close() {
        if (!this._overlay) return;

        const overlay = this._overlay;
        this._overlay = null;
        this._mode = null;
        this._appId = null;
        this._previews = [];
        this._dim = null;
        this._blur = null;

        if (this._grab) {
            try { Main.popModal(this._grab); } catch (_e) { /* already popped */ }
            this._grab = null;
        }

        overlay.disconnectObject(this);
        overlay.remove_all_transitions();
        overlay.reactive = false;

        const finish = () => {
            if (overlay.get_parent())
                Main.uiGroup.remove_child(overlay);
            overlay.destroy();
        };

        if (this._ANIM_MS > 0) {
            overlay.ease({
                opacity: 0,
                duration: this._ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: finish,
            });
        } else {
            finish();
        }
    }

    /** Best-effort frozen + blurred snapshot of the screen at entry. */
    _addBlurBackdrop(sw, sh) {
        if (!this._settings.get_boolean('blur-enabled')) return;
        try {
            const rect = new Mtk.Rectangle({
                x: 0, y: 0, width: sw, height: sh,
            });
            const [, , , scale] = global.stage.get_capture_final_size(rect);
            const content = global.stage.paint_to_content(
                rect, scale, null, Clutter.PaintFlag.NO_CURSORS);
            if (!content) return;

            const blur = new St.Widget({ content, reactive: false });
            blur.set_position(0, 0);
            blur.set_size(sw, sh);
            blur.add_effect(new Clutter.BlurEffect());
            this._overlay.add_child(blur);
            this._blur = blur;
        } catch (_e) {
            this._blur = null;
        }
    }

    // ── Previews ────────────────────────────────────────────────────────

    _makePreview(item, animate) {
        const sf = this._scaleFactor;
        const { win, orig, target } = item;
        const actor = win.get_compositor_private?.();
        if (!actor) return null;

        const inset = Math.round(FRAME_INSET * sf);

        const frame = new St.Widget({
            reactive: true,
            style_class: this._cls('expose-frame'),
        });
        frame.set_size(target.w, target.h);
        frame.set_pivot_point(0, 0);
        frame._previewRef = { win };

        const clone = new Clutter.Clone({ source: actor, reactive: false });
        clone.set_size(target.w - inset * 2, target.h - inset * 2);
        clone.set_position(inset, inset);
        frame.add_child(clone);

        const title = new St.Label({
            text: this._titleFor(win),
            style_class: this._cls('expose-title'),
            reactive: false,
            opacity: 0,
        });
        title.set_position(inset, target.h - TITLE_H * sf);
        title.set_width(target.w - inset * 2);
        title.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        title.clutter_text.set_single_line_mode(true);
        frame.add_child(title);

        this._sig(frame, 'enter-event', () => {
            frame.add_style_class_name('expose-frame-hover');
            title.opacity = 255;
            return Clutter.EVENT_PROPAGATE;
        });
        this._sig(frame, 'leave-event', () => {
            frame.remove_style_class_name('expose-frame-hover');
            if (this._previews[this._focused]?.frame !== frame)
                title.opacity = 0;
            return Clutter.EVENT_PROPAGATE;
        });

        this._overlay.add_child(frame);
        this._previews.push({ win, frame, clone, title, orig, target });

        if (animate) {
            const startScale = orig.w / target.w;
            frame.set_scale(startScale, startScale);
            frame.set_position(orig.x, orig.y);
            frame.ease({
                scale_x: 1, scale_y: 1,
                x: target.x, y: target.y,
                duration: this._ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            frame.set_position(target.x, target.y);
        }
        return frame;
    }

    _titleFor(win) {
        let t = win.get_title() || '';
        if (!t) {
            const app = Shell.WindowTracker.get_default().get_window_app(win);
            t = app ? app.get_name() : '';
        }
        if (!t) return '';
        return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
    }

    _previewAtPointer() {
        const [px, py] = global.get_pointer();
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, px, py);
        while (actor) {
            if (actor._previewRef) return actor._previewRef;
            actor = actor.get_parent();
        }
        return null;
    }

    // ── Interaction ─────────────────────────────────────────────────────

    _activateWindow(win) {
        if (win.minimized) win.unminimize();
        win.activate(global.get_current_time());
        this._close();
    }

    _moveFocus(delta) {
        if (this._previews.length === 0) return;
        this._focused = (this._focused + delta + this._previews.length) % this._previews.length;
        this._updateFocusHighlight();
    }

    _updateFocusHighlight() {
        this._previews.forEach((pv, i) => {
            const focused = i === this._focused;
            pv.frame.set_style_class_name(focused
                ? this._cls('expose-frame', 'expose-frame-focused')
                : this._cls('expose-frame'));
            pv.title.opacity = focused ? 255 : 0;
        });
    }

    _cycleApp(direction) {
        if (this._mode !== 'app') return;
        const tracker = Shell.WindowTracker.get_default();
        const ws = global.workspace_manager.get_active_workspace();

        const ids = [];
        const seen = new Set();
        for (const w of ws.list_windows()) {
            if (!_isNormal(w)) continue;
            const a = tracker.get_window_app(w);
            if (!a) continue;
            if (seen.has(a.get_id())) continue;
            seen.add(a.get_id());
            ids.push(a.get_id());
        }
        if (ids.length === 0) return;

        let idx = ids.indexOf(this._appId);
        if (idx === -1) idx = 0;
        idx = (idx + direction + ids.length) % ids.length;
        this._appId = ids[idx];
        this._rebuildPreviews();
    }

    _rebuildPreviews() {
        if (!this._overlay) return;
        this._previews.forEach(pv => pv.frame.destroy());
        this._previews = [];

        const layout = this._layout(this._collectWindows());
        for (const item of layout) this._makePreview(item, false);

        this._focused = 0;
        this._updateFocusHighlight();
    }

    _onKeyPress(_a, event) {
        if (!this._overlay) return Clutter.EVENT_PROPAGATE;

        const key = event.get_key_symbol();
        const state = event.get_state();

        switch (key) {
            case Clutter.KEY_Escape:
                this._close();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Return:
            case Clutter.KEY_KP_Enter:
            case Clutter.KEY_space:
                if (this._previews[this._focused])
                    this._activateWindow(this._previews[this._focused].win);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Left:
            case Clutter.KEY_Up:
                this._moveFocus(-1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Right:
            case Clutter.KEY_Down:
                this._moveFocus(1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Tab:
            case Clutter.KEY_ISO_Left_Tab:
                this._cycleApp((state & Clutter.ModifierType.SHIFT_MASK) ? -1 : 1);
                return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
}


export default class ExposeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._expose = new Expose(this._settings);
        this._expose.enable();
    }

    disable() {
        this._expose?.disable();
        this._expose = null;
        this._settings = null;
    }
}
