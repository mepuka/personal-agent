export function App() {
  return (
    <box flexDirection="column" flexGrow={1}>
      <box border="solid" padding={1}>
        <text content="Personal Agent TUI" fg="cyan" />
      </box>
      <box flexGrow={1} padding={1}>
        <text content="Loading..." />
      </box>
    </box>
  )
}
