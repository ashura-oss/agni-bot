import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TaskInfo } from "@agni/client";
import { RootView } from "../src/components/RootView";
import { AppModel } from "../src/state/app-model";
import { AppModelProvider } from "../src/state/use-app-model";

const task = (overrides: Partial<TaskInfo> = {}): TaskInfo => ({
  id: "task_1", title: "Write the report", dueAt: new Date().toISOString(), priority: "normal", status: "open",
  snoozedUntil: null, createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T09:00:00.000Z", listID: "lst_inbox",
  ...overrides,
} as TaskInfo);

function openTasks(tasks: TaskInfo[] = []) {
  const model = new AppModel({ healthPollMs: 0 });
  Object.assign(model, { screen: "chat", tasks });
  model.toggleTasks();
  render(<AppModelProvider model={model}><RootView /></AppModelProvider>);
  return model;
}

/** Opens a row menu: a click for the old <details>, a pointer press for the Radix trigger. */
function openRowMenu(title: string) {
  const trigger = screen.getByLabelText(`More actions for ${title}`);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

beforeEach(() => { localStorage.clear(); window.history.replaceState({}, "", "/"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Tasks screen: Escape", () => {
  it("closes only the New task dialog when Escape is pressed in its title field", () => {
    const model = openTasks();
    fireEvent.click(screen.getAllByRole("button", { name: /Add task/ })[0]!);
    const title = screen.getByPlaceholderText("What needs to get done?");
    fireEvent.change(title, { target: { value: "half typed" } });
    fireEvent.keyDown(title, { key: "Escape" });
    expect(screen.queryByPlaceholderText("What needs to get done?")).toBeNull();
    expect(model.getSnapshot().isTasksPresented).toBe(true);
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
  });

  it("closes only the dialog when Escape arrives with nothing focused", () => {
    const model = openTasks();
    fireEvent.click(screen.getAllByRole("button", { name: /Add task/ })[0]!);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByPlaceholderText("What needs to get done?")).toBeNull();
    expect(model.getSnapshot().isTasksPresented).toBe(true);
  });

  it("closes only the detail sheet and only the activity sheet", () => {
    const model = openTasks([task()]);
    fireEvent.click(screen.getByRole("button", { name: "Write the report" }));
    expect(screen.getByLabelText(/Details for Write the report/)).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByLabelText(/Details for/)).toBeNull();
    expect(model.getSnapshot().isTasksPresented).toBe(true);

    openRowMenu("Write the report");
    fireEvent.click(screen.getByText(/View activity/));
    expect(screen.getByRole("heading", { name: "Task activity" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("heading", { name: "Task activity" })).toBeNull();
    expect(model.getSnapshot().isTasksPresented).toBe(true);
  });

  it("still closes the Tasks screen when no dialog is open", () => {
    const model = openTasks();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(model.getSnapshot().isTasksPresented).toBe(false);
  });
});
