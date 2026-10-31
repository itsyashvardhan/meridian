import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function renderComposer(start: () => void) {
  return render(
    <Composer
      compact
      onSubmit={() => {}}
      voiceCall={{ active: false, supported: true, onStart: start }}
    />,
  );
}

test("voice call explains unfiltered provider audio before microphone access", async () => {
  const start = mock();
  const view = renderComposer(start);

  fireEvent.click(view.getByRole("button", { name: "Start voice call" }));
  expect(view.getByRole("dialog")).toBeDefined();
  expect(view.getByText(/audio is not PII-filtered/i)).toBeDefined();
  expect(start).not.toHaveBeenCalled();
  const dialog = view.getByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Start voice call" }),
  );
  expect(start).toHaveBeenCalledTimes(1);
});
