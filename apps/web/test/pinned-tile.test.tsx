import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SidebarView } from "../src/components/SidebarView";
import { AppModel } from "../src/state/app-model";
import { AppModelProvider } from "../src/state/use-app-model";

// A pinned bot is drawn as a tile and leaves the roster list, so the star in its row is gone. The tile
// needs its own way back: a real button, reachable by keyboard and on a phone.

beforeEach(() => { localStorage.clear(); window.history.replaceState({}, "", "/"); });
afterEach(() => { cleanup(); localStorage.clear(); });

function sidebarWithPinned(): AppModel {
  const model = new AppModel({ healthPollMs: 0 });
  const first = model.filteredAgents[0]!;
  model.toggleFavorite(first.id);
  render(<AppModelProvider model={model}><SidebarView /></AppModelProvider>);
  return model;
}

describe("a pinned bot tile", () => {
  it("has an Unpin button that is a sibling of the tile, not nested inside it", () => {
    const model = sidebarWithPinned();
    const name = model.filteredAgents[0]!.name;
    const tile = screen.getByRole("button", { name: `Open ${name} chat` });
    const unpin = screen.getByRole("button", { name: `Unpin ${name}` });
    expect(tile.contains(unpin)).toBe(false);
    expect(unpin.tagName).toBe("BUTTON");
  });

  it("unpins on click and the bot returns to the list", () => {
    const model = sidebarWithPinned();
    const first = model.filteredAgents[0]!;
    expect(model.getSnapshot().preferences.favorites).toEqual([first.id]);
    fireEvent.click(screen.getByRole("button", { name: `Unpin ${first.name}` }));
    expect(model.getSnapshot().preferences.favorites).toEqual([]);
    expect(screen.queryByRole("button", { name: `Unpin ${first.name}` })).not.toBeInTheDocument();
    // Unpinned, it is a roster row again, with the Pin control of its own.
    expect(screen.getByRole("button", { name: `Pin ${first.name}` })).toBeInTheDocument();
  });

  it("does not open the chat when it is used", () => {
    const model = sidebarWithPinned();
    const first = model.filteredAgents[0]!;
    const before = model.getSnapshot().conversation.agentID;
    fireEvent.click(screen.getByRole("button", { name: `Unpin ${first.name}` }));
    expect(model.getSnapshot().conversation.agentID).toBe(before);
  });

  it("moves focus to the bot's roster row when the tile goes away, so a keyboard user is not dropped on the page", async () => {
    const model = sidebarWithPinned();
    const first = model.filteredAgents[0]!;
    fireEvent.click(screen.getByRole("button", { name: `Unpin ${first.name}` }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: `Open ${first.name} chat` })));
  });
});
