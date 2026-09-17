/**
 * Exposé (Tahoe) — Preferences UI
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import * as Config from 'resource:///org/gnome/Shell/Extensions/js/misc/config.js';


export default class ExposePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const behaviorPage = new Adw.PreferencesPage({
            title: _('Behavior'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(behaviorPage);

        const shortcutGroup = new Adw.PreferencesGroup({
            title: _('Shortcuts'),
            description: _('No shortcut is set by default — click Set to choose one. It takes effect immediately.'),
        });
        behaviorPage.add(shortcutGroup);

        this._addShortcutRow(shortcutGroup, settings, 'keybinding-all-windows',
            _('All Windows'), _('Show every window on the active workspace'));
        this._addShortcutRow(shortcutGroup, settings, 'keybinding-app-expose',
            _('App Exposé'), _('Show only the focused application\'s windows'));

        const lookPage = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(lookPage);

        const bgGroup = new Adw.PreferencesGroup({
            title: _('Background'),
            description: _('How the desktop looks behind the window previews'),
        });
        lookPage.add(bgGroup);

        const blurSwitch = new Adw.SwitchRow({
            title: _('Blur Background'),
            subtitle: _('Falls back to a plain dim if the compositor cannot capture the screen'),
        });
        settings.bind('blur-enabled', blurSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        bgGroup.add(blurSwitch);

        this._addSpinRow(bgGroup, settings, 'dim-amount',
            _('Dim Amount'), _('0 = none, 1 = black'), 0.0, 0.95, 0.05);

        const cardGroup = new Adw.PreferencesGroup({ title: _('Window Previews') });
        lookPage.add(cardGroup);

        this._addSpinRow(cardGroup, settings, 'corner-radius',
            _('Corner Radius'), _('Preview frame corner radius (px)'), 0, 40, 1);
        this._addSpinRow(cardGroup, settings, 'max-scale',
            _('Maximum Scale'), _('Largest a preview may grow (%)'), 50, 100, 5);
        this._addSpinRow(cardGroup, settings, 'min-scale',
            _('Minimum Scale'), _('Smallest a preview may shrink (%)'), 5, 60, 1);
        this._addSpinRow(cardGroup, settings, 'animation-duration',
            _('Animation Duration'), _('Enter/exit animation (ms, 0 = instant)'), 0, 1000, 25);

        const aboutPage = new Adw.PreferencesPage({
            title: _('About'),
            icon_name: 'dialog-information-symbolic',
        });
        window.add(aboutPage);

        const infoGroup = new Adw.PreferencesGroup({ title: _('Exposé (Tahoe)') });
        aboutPage.add(infoGroup);

        infoGroup.add(new Adw.ActionRow({
            title: _('Version'),
            subtitle: this.metadata['version-name'] || '1.0.0',
        }));
        infoGroup.add(new Adw.ActionRow({
            title: _('GNOME Shell'),
            subtitle: Config.PACKAGE_VERSION || _('unknown'),
        }));
    }

    _addSpinRow(group, settings, key, title, subtitle, min, max, step) {
        const row = new Adw.ActionRow({ title, subtitle });
        const adj = new Gtk.Adjustment({
            lower: min, upper: max,
            step_increment: step, page_increment: step * 5,
        });
        const spin = new Gtk.SpinButton({
            adjustment: adj,
            valign: Gtk.Align.CENTER,
            digits: step < 1 ? 2 : 0,
        });
        settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(spin);
        group.add(row);
        return row;
    }

    _addShortcutRow(group, settings, key, title, subtitle) {
        const row = new Adw.ActionRow({ title, subtitle });

        const label = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        const refresh = () => {
            const accels = settings.get_strv(key);
            label.set_accelerator(accels.length > 0 ? accels[0] : '');
        };
        refresh();
        const sid = settings.connect(`changed::${key}`, refresh);
        row.connect('destroy', () => settings.disconnect(sid));

        const setBtn = new Gtk.Button({ label: _('Set'), valign: Gtk.Align.CENTER });
        setBtn.connect('clicked', () => this._captureShortcut(setBtn.get_root(), settings, key));

        const clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Clear shortcut'),
        });
        clearBtn.connect('clicked', () => settings.set_strv(key, []));

        row.add_suffix(label);
        row.add_suffix(setBtn);
        row.add_suffix(clearBtn);
        group.add(row);
    }

    _captureShortcut(parent, settings, key) {
        const dialog = new Adw.AlertDialog({
            heading: _('Press shortcut'),
            body: _('Press the key combination you want to use, or Escape to cancel.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, _kc, state) => {
            if (this._isModifierKey(keyval)) return Gdk.EVENT_PROPAGATE;

            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_Escape && mask === 0) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            const accel = Gtk.accelerator_name(keyval, mask);
            if (accel && accel.length > 0) {
                settings.set_strv(key, [accel]);
                dialog.close();
            }
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present(parent);
    }

    _isModifierKey(keyval) {
        return keyval === Gdk.KEY_Control_L || keyval === Gdk.KEY_Control_R ||
               keyval === Gdk.KEY_Shift_L   || keyval === Gdk.KEY_Shift_R   ||
               keyval === Gdk.KEY_Alt_L     || keyval === Gdk.KEY_Alt_R     ||
               keyval === Gdk.KEY_Super_L   || keyval === Gdk.KEY_Super_R   ||
               keyval === Gdk.KEY_Meta_L    || keyval === Gdk.KEY_Meta_R    ||
               keyval === Gdk.KEY_Hyper_L   || keyval === Gdk.KEY_Hyper_R;
    }
}
