window.__ModuleLoader__.load({
	id: "dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let jsx = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** Locale namespace owned by this plugin. */
		const NS = "session-delete";
		const zh = {
			"menu.delete": "删除会话",
			"confirm": "删除会话「{title}」？\n\n将同时删除：会话存储、工作区记录，以及项目目录下的会话文件夹。此操作不可恢复。",
			"working": "正在删除会话…",
			"failed": "删除失败：{error}",
		};
		const en = {
			"menu.delete": "Delete session",
			"confirm": "Delete session \"{title}\"?\n\nThis removes the stored session, its workspace record, and the project's local session folder. This cannot be undone.",
			"working": "Deleting session…",
			"failed": "Delete failed: {error}",
		};

		/** Ask the host to delete one session and its project folder. */
		async function requestDelete(sessionId, title, t) {
			if (!window.confirm(t("confirm", { title }))) return;
			try {
				const response = await fetch("/api/session.delete", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId: String(sessionId) }),
				});
				const result = await response.json().catch(() => ({}));
				if (!response.ok || !result.ok) throw new Error(result.error || ("HTTP " + response.status));
				window.location.reload();
			} catch (error) {
				window.alert(t("failed", { error: error instanceof Error ? error.message : String(error) }));
			}
		}

		/** Sidebar session row action: one destructive menu entry. */
		function DeleteRow(props) {
			const { sessionId, displayTitle, useMenuOpenState, deleteSession, t } = props;
			const [, setMenuOpen] = useMenuOpenState();
			return jsx.jsx(primitives.MenuItemButton, {
				separatorBefore: true,
				onSelect: () => {
					setMenuOpen(false);
					deleteSession(sessionId, displayTitle, t);
				},
				children: t("menu.delete"),
			});
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-delete: dictionaries");
			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "session-delete",
				order: 500,
				locale: NS,
				inject: () => ({
					deleteSession: (sessionId, title, t) => requestDelete(sessionId, title, t),
				}),
			}, DeleteRow));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});