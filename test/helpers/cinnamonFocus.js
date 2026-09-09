// Executed inside the disposable Cinnamon desktop by check_cinnamon_imports.py.
(() => {
    const GLib = imports.gi.GLib;
    const applet = imports.ui.appletManager.get_object_for_uuid(
        "chronos@geraldo-netto", "chronos@geraldo-netto");
    const namespace = imports.ui.appletManager.applets["chronos@geraldo-netto"];
    const versioned = GLib.build_filenamev([
        GLib.get_user_data_dir(), "cinnamon", "applets", "chronos@geraldo-netto", "6.0"]);
    const selectedDayAgenda = imports.misc.fileUtils.requireModule(
        versioned + "/selectedDayAgenda.js", versioned, applet._meta, "applet");
    const list = applet.event_list;
    let revision = 1000;
    const checks = [];

    function assert(condition, message) {
        if (!condition) throw new Error(message);
    }

    function nextTurn() {
        return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
    }

    function agenda(count) {
        const start = list.selectedDate.to_unix() + 3600;
        const events = Array.from({ length: count }, (_value, index) =>
            new namespace.eventData.EventData({ deep_unpack: () => [
                `native-${index}`, "#123456", `Native event ${index}`, false,
                start, start + 3600, start
            ] }, revision));
        return { timestamp: ++revision, length: events.length, get_event_list: () => events };
    }

    async function settleRows() {
        for (let turn = 0; turn < 40; turn++) {
            await nextTurn();
            if (!list._renderer._build_rows_idle_id) return;
        }
        throw new Error("native row rendering did not settle");
    }

    async function prepare() {
        applet.menu.open(false);
        list._calendar_launcher = { isAvailable: () => true };
        list.set_unavailable(false);
        list.actor.show();
        list.set_events(null, false);
        await nextTurn();
        list.no_events_button.grab_key_focus();
        assert(global.stage.get_key_focus() === list.no_events_button, "empty button receives focus");
        assert(applet.menu.isOpen, "popup starts open");
    }

    async function arrival(name, data, target) {
        await prepare();
        // Delivery happens in a later main-loop turn, as it does for EDS/holidays.
        await nextTurn();
        list.set_events(data(), false);
        await settleRows();
        assert(applet.menu.isOpen, `${name}: popup remains open`);
        assert(global.stage.get_key_focus() === target(), `${name}: focus reaches its destination`);
        checks.push(name);
    }

    async function hideAgenda(name, target, data, preserveExternal = false) {
        await prepare();
        list.set_events(data(), false);
        await settleRows();
        applet._calendar.focusSelectedDay();
        const selectedDay = global.stage.get_key_focus();
        const focused = target(selectedDay);
        focused.grab_key_focus();
        assert(global.stage.get_key_focus() === focused, `${name}: initial focus is assigned`);
        applet._eventListCoordinator.apply(false);
        await nextTurn();
        assert(!list.actor.visible, `${name}: agenda is hidden`);
        assert(applet.menu.isOpen, `${name}: popup remains open`);
        assert(global.stage.get_key_focus() === (preserveExternal ? focused : selectedDay),
            `${name}: focus reaches its destination`);
        checks.push(name);
    }

    async function checkHiding() {
        await hideAgenda("T1162 focused event", () => list.rows[0].actor, () => agenda(1));
        await hideAgenda("T1162 focused heading", () => list.selected_date_label, () => null);
        await hideAgenda("T1162 focused empty button", () => list.no_events_button, () => null);
        await hideAgenda("T1162 external focus", selected =>
            applet._calendar._gridView.dayCells.find(cell => cell.button !== selected).button,
        () => null, true);
    }

    async function run() {
        await arrival("T1161 event arrival", () => agenda(1), () => list.rows[0].actor);
        await arrival("T1161 chunked arrival", () => agenda(65), () => list.rows[0].actor);
        await arrival("T1161 holiday arrival", () =>
            selectedDayAgenda.composeSelectedDayAgenda(null,
                { name: "Native holiday", flags: ["public_holiday"] }),
        () => list.selected_date_label);
        await prepare();
        applet._calendar.focusSelectedDay();
        const external = global.stage.get_key_focus();
        list.set_events(agenda(1), false);
        await nextTurn();
        assert(applet.menu.isOpen && global.stage.get_key_focus() === external,
            "T1161: incoming events preserve calendar focus");
        checks.push("T1161 external focus");
        await checkHiding();
        return checks;
    }

    global.chronosFocusRegression = null;
    run().then(result => { global.chronosFocusRegression = { checks: result, failures: [] }; })
        .catch(error => { global.chronosFocusRegression = { checks, failures: [String(error)] }; });
    return true;
})()
