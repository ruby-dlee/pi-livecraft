# Workspace and sessions

`useWorkspaceSessions` owns workspace selection and the session lists shown by the application. It coordinates initial selection, refreshes, creation, reopening, renaming and closing, optimistic naming, pending UI requests, and the local persistence of recent workspaces, completed sessions, and pinned sessions.

Keep session-list reconciliation and workspace/session persistence in this controller. `App.tsx` supplies cross-feature callbacks, such as clearing feature state when the workspace changes or preparing an initial composer draft; it should not duplicate the controller's state.

Directory browsing remains in `DirectoryPicker`. Workspace paths accept both `~/...` and Windows `~\...`; completion preserves the separator style the user typed. Pure list and persistence rules live in the neighboring `sidebar-sessions.ts` and `recent-workspaces.ts` modules.

`WorkspaceSidebar` also exposes the prominent Firstmate launch action. It calls the input-free `launchFirstmate` API and adopts the returned workspace/session; the browser never supplies executable, environment, extension, or path configuration. The manager-owned preset in `server/firstmate-preset.ts` owns those trusted launcher settings, while generic New session behavior remains unchanged.
