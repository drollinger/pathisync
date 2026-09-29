import { assertEquals, assertThrows } from "@std/assert";
import { ConfigError } from "../src/errors.ts";
import { formatLinks, widgetLinks } from "../src/links.ts";
import {
  collection,
  flow,
  localCollection,
  makeProject,
  trigger,
} from "./helpers.ts";

const runs = (sub: string) => ({
  className: "flowOrchestrator",
  config: { name: "run", flowOrchestrator: sub },
});

function project() {
  const widget = collection("w", [
    { id: "page", path: "/widget/index.html", content: "" },
    { id: "logo", path: "/widget/logo.png", content: "" },
  ]);
  (widget.resources as { resourceHeaders: unknown }[])[1].resourceHeaders = [
    ["Content-Type", "image/png"],
  ];
  const root = makeProject({
    "resources/group/w/_collection.json": localCollection(widget),
    "resources/group/w/widget/index.html": `<script>
      fetch('/api/balances?x=1'); $.ajax({ url: "/api/holds/" });
    </script>`,
    "resources/group/w/widget/notes.txt":
      "/api/unused (not listed, so not served)",
    "flows/@campus/balances/flow.json": {
      ...flow("balances@campus"),
      processors: { a: runs("fetch@campus"), b: runs("missing@campus") },
    },
    "flows/@campus/balances/http_balances.trigger.json": trigger("http_balances", {
      path: "/api/balances",
      orchestratorName: "balances@campus",
    }),
    "flows/@campus/fetch/flow.json": {
      ...flow("fetch@campus"),
      processors: { c: runs("balances@campus") },
    },
    "triggers/http_bal.json": trigger("http_bal", {
      path: "/api/bal",
      orchestratorName: "x",
    }),
    "triggers/http_holds.json": trigger("http_holds", {
      path: "/api/holds/",
      orchestratorName: "holds@elsewhere",
    }),
    "triggers/http_unused.json": trigger("http_unused", {
      path: "/api/unused",
    }),
    "triggers/timer.json": {
      ...trigger("timer", { path: "/api/balances" }),
      classPath: "timer",
    },
  });
  // Binary content is never searched, even if it happens to hold a path.
  Deno.writeFileSync(
    `${root}/resources/group/w/widget/logo.png`,
    new Uint8Array([
      0x89,
      0x50,
      0xff,
      0,
      ...new TextEncoder().encode("/api/unused"),
    ]),
  );
  return root;
}

Deno.test("prints triggers → flows → sub-flows for a widget", () => {
  const root = project();
  assertEquals(
    formatLinks(widgetLinks(root, "resources/group/w")),
    [
      "w (resources/group/w)",
      "├─ trigger http_balances  /api/balances  (called from widget/index.html)",
      "│  └─ flow balances@campus  flows/@campus/balances/",
      "│     ├─ flow fetch@campus  flows/@campus/fetch/",
      "│     │  └─ flow balances@campus  (runs itself, see above)",
      "│     └─ flow missing@campus  (not local)",
      "└─ trigger http_holds  /api/holds/  (called from widget/index.html)",
      "   └─ flow holds@elsewhere  (not local)",
    ].join("\n"),
  );
});

Deno.test("finds the collection from a file in it or its id", () => {
  const root = project();
  const byFolder = widgetLinks(root, "resources/group/w");
  assertEquals(
    widgetLinks(root, "resources/group/w/widget/index.html"),
    byFolder,
  );
  assertEquals(widgetLinks(root, "w"), byFolder);
  assertThrows(() => widgetLinks(root, "flows"), ConfigError);
  assertThrows(() => widgetLinks(root, "nope"), ConfigError);
});

Deno.test("says so when a widget calls no triggers", () => {
  const root = makeProject({
    "resources/c/_collection.json": localCollection(
      collection("c", [{ id: "p", path: "/p.html", content: "" }]),
    ),
    "resources/c/p.html": "<p>static</p>",
  });
  assertEquals(
    formatLinks(widgetLinks(root, "c")),
    "c (resources/c)\n  No trigger paths found in its resources. URLs built at runtime can't be detected.",
  );
});
