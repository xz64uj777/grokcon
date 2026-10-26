import { useEffect, useRef, useState } from "react";
import { CircleDollarSign, Gauge, Mountain, Pickaxe, Users, Volume2, VolumeX, X } from "lucide-react";
import type { GameApi, UpgradeKind, ViewModel } from "@/game/types";

export function MineScreen() {
  const worldRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<GameApi | null>(null);
  const bridges = useRef({ toggle: () => {}, close: () => {} });
  const [hud, setHud] = useState<ViewModel | null>(null);
  const [panel, setPanel] = useState<null | "machines" | "ground" | "crew">(null);
  const [company, setCompany] = useState("Ridge Ore Co.");
  const [seeded, setSeeded] = useState(false);
  const [booksNote, setBooksNote] = useState("");
  const [wipe, setWipe] = useState(false);

  bridges.current.toggle = () => setPanel((p) => (p ? null : "machines"));
  bridges.current.close = () => setPanel(null);

  useEffect(() => {
    const host = worldRef.current;
    if (!host) return;
    let stop = () => {};
    let dead = false;
    void import("@/game/mount").then(({ mountGame }) => {
      if (dead) return;
      stop = mountGame(host, {
        onHud: (view) => {
          if (!dead) setHud(view);
        },
        onApi: (api) => {
          apiRef.current = api;
        },
        onTogglePanel: () => bridges.current.toggle(),
        onClosePanel: () => bridges.current.close(),
      });
    });
    return () => {
      dead = true;
      stop();
    };
  }, []);

  useEffect(() => {
    if (hud?.booksReady && !seeded) {
      setCompany(hud.company);
      setSeeded(true);
    }
  }, [hud, seeded]);

  useEffect(() => {
    apiRef.current?.setPanel(panel !== null);
  }, [panel]);

  const playing = hud?.mode === "play";

  return (
    <main className="game-shell fixed inset-0 bg-bg text-fg">
      <div ref={worldRef} className="absolute inset-0" />
      {!playing && (
        <section className="pointer-events-auto absolute top-4 right-4 bottom-4 left-4 overflow-y-auto border border-border bg-surface p-5 md:right-auto md:bottom-auto md:left-10 md:w-96 md:p-8">
          <p className="font-display text-sm uppercase tracking-widest text-primary">Open pit</p>
          <h1 className="mt-1 font-display text-5xl uppercase leading-none text-fg md:text-6xl">Ridge Ore</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Scoop iron, buy machines, lease ground, wash gold.
          </p>
          <ol className="desk-only mt-4 space-y-2 text-sm leading-relaxed text-fg">
            <li>1. Scoop the iron pile. Press Next, drive the track crusher to the dig, and dump beside it.</li>
            <li>2. Buy machines and upgrades. Hire operators for the seats you leave.</li>
            <li>3. Lease benches, wash gold at the sluice, and run a full crew.</li>
          </ol>
          <label className="mt-5 block text-sm text-muted">
            Company
            <input
              value={company}
              maxLength={24}
              onChange={(e) => setCompany(e.target.value)}
              className="mt-2 h-11 w-full border border-border bg-bg px-3 text-fg outline-none"
            />
          </label>
          <p className="mt-3 text-sm text-cash">{hud ? hud.savedBlurb : "Opening the gate…"}</p>
          {hud?.booksReady ? (
            <button
              type="button"
              className="mt-4 h-12 w-full bg-primary font-display text-xl uppercase tracking-wide text-primary-fg"
              onClick={(e) => {
                e.currentTarget.blur();
                apiRef.current?.start("continue", company);
              }}
            >
              {hud.hadSave ? "Continue" : "Start"}
            </button>
          ) : (
            <p className="mt-4 text-sm text-muted">Checking the books…</p>
          )}
          {hud?.hadSave && (
            <button
              type="button"
              className="mt-2 h-11 w-full border border-border font-display text-lg uppercase tracking-wide text-fg"
              onClick={(e) => {
                e.currentTarget.blur();
                apiRef.current?.downloadBooks();
              }}
            >
              Download books
            </button>
          )}
          <label className="mt-2 flex h-11 w-full cursor-pointer items-center justify-center border border-border font-display text-lg uppercase tracking-wide text-fg">
            Load books
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.currentTarget.value = "";
                if (!file) return;
                void file.text().then((text) => {
                  const ok = apiRef.current?.importBooks(text) ?? false;
                  setBooksNote(ok ? "Books loaded. Press continue." : "That file is not a Ridge Ore save.");
                });
              }}
            />
          </label>
          {booksNote && <p className="mt-2 text-sm text-cash">{booksNote}</p>}
          {hud?.hadSave && (
            <button
              type="button"
              className="mt-2 h-11 w-full border border-border font-display text-lg uppercase tracking-wide text-fg"
              onClick={(e) => {
                e.currentTarget.blur();
                if (!wipe) {
                  setWipe(true);
                  return;
                }
                apiRef.current?.start("fresh", company);
              }}
            >
              {wipe ? "Wipe the books" : "New claim"}
            </button>
          )}
          <p className="key-hint mt-4 text-sm leading-relaxed text-muted">
            WASD drives. Hold Space to dig or dump. The books save on this phone. Download a copy before you switch devices.
          </p>
        </section>
      )}
      {playing && hud && (
        <>
          <header className="pointer-events-none absolute inset-x-0 top-0 z-10 p-3 md:p-4">
            <div className="flex items-center gap-2">
              <div className="pointer-events-auto border border-border bg-surface px-3 py-2">
                <div className="flex items-center gap-2">
                  <CircleDollarSign className="size-4 text-cash" aria-hidden />
                  <p className="font-display text-xl leading-none tracking-wide text-cash md:text-2xl">{hud.cashLabel}</p>
                </div>
                <div className="desk-only">
                  <p className="mt-1 text-sm text-fg">{hud.tier}</p>
                  <div className="mt-2 h-1.5 w-36 bg-bg">
                    <div className="h-full bg-cash" style={{ width: `${Math.round(hud.tierProgress * 100)}%` }} />
                  </div>
                  <p className="mt-1 max-w-56 text-sm text-muted">{hud.tierDetail}</p>
                </div>
              </div>
              <div className="desk-only pointer-events-auto max-w-sm border border-border bg-surface px-3 py-2">
                <p className="font-display text-lg uppercase leading-tight tracking-wide text-fg">{hud.objective}</p>
                {hud.contractLabel && <p className="mt-1 text-sm text-cash">{hud.contractLabel}</p>}
                <p className="mt-1 text-sm text-muted">{hud.shift}</p>
              </div>
              <button
                type="button"
                className="pointer-events-auto ml-auto inline-flex h-11 items-center gap-2 border border-border bg-surface px-3 font-display text-lg uppercase tracking-wide text-fg"
                onClick={() => setPanel((p) => (p ? null : "machines"))}
              >
                <Mountain className="size-4" aria-hidden />
                Office
              </button>
              <button
                type="button"
                className="pointer-events-auto inline-flex h-11 items-center justify-center border border-border bg-surface px-3 font-display text-lg uppercase tracking-wide text-fg"
                aria-label="Change camera view"
                onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyC", bubbles: true }))}
              >
                View
              </button>
              <button
                type="button"
                className="pointer-events-auto inline-flex h-11 w-11 items-center justify-center border border-border bg-surface text-fg"
                aria-label={hud.muted ? "Unmute" : "Mute"}
                onClick={() => apiRef.current?.toggleMute()}
              >
                {hud.muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
              </button>
            </div>
          </header>
          <footer className="hud-foot pointer-events-none absolute inset-x-0 bottom-0 z-10 p-3 md:p-4">
            <div className="max-w-md border border-border bg-surface px-3 py-2 md:py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="font-display text-lg uppercase leading-none tracking-wide text-fg md:text-xl">{hud.vehicleName}</p>
                <p className="flex items-center gap-1 text-sm text-muted">
                  <Gauge className="size-4" aria-hidden />
                  {hud.speedLabel}
                </p>
              </div>
              <p className="mt-1 text-sm text-fg">{hud.cargoLabel}</p>
              <div className="mt-1 h-2 bg-bg md:mt-2">
                <div className="h-full bg-primary" style={{ width: `${Math.round(hud.cargoFrac * 100)}%` }} />
              </div>
              <p className="desk-only mt-2 text-sm leading-relaxed text-muted">{hud.hint}</p>
              {hud.log[0] && <p className="mt-1 truncate text-sm text-cash">{hud.log[0]}</p>}
            </div>
            <p className="key-hint mt-2 text-sm text-muted">Space works the tool · V next machine · View changes camera · drag to orbit · pinch to zoom · Tab office</p>
          </footer>
          <div className="touch-ui pointer-events-none absolute inset-x-0 bottom-0 z-10 items-end justify-between p-4 pb-6">
            <Joystick onChange={(steer, throttle) => apiRef.current?.setStick(steer, throttle)} />
            <div className="pointer-events-auto flex flex-col items-end gap-3">
              <button
                type="button"
                className="h-12 border border-border bg-surface px-4 font-display text-lg uppercase tracking-wide text-fg"
                onClick={() => apiRef.current?.cycle(1)}
              >
                Next
              </button>
              <button
                type="button"
                className="h-14 border border-border bg-surface px-4 font-display text-lg uppercase tracking-wide text-fg"
                onClick={() => apiRef.current?.loadTruck()}
              >
                Load
              </button>
              <button
                type="button"
                className="flex h-20 w-20 items-center justify-center bg-primary font-display text-xl uppercase tracking-wide text-primary-fg"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  apiRef.current?.setAction(true);
                }}
                onPointerUp={() => apiRef.current?.setAction(false)}
                onPointerCancel={() => apiRef.current?.setAction(false)}
              >
                Dig
              </button>
            </div>
          </div>
          {panel && (
            <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-md flex-col border-l border-border bg-surface">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div>
                  <p className="font-display text-2xl uppercase leading-none tracking-wide text-fg">Yard office</p>
                  <p className="mt-1 text-sm text-cash">{hud.cashLabel}</p>
                </div>
                <button
                  type="button"
                  className="inline-flex h-11 w-11 items-center justify-center border border-border text-fg"
                  aria-label="Close office"
                  onClick={() => setPanel(null)}
                >
                  <X className="size-5" />
                </button>
              </div>
              <div className="flex border-b border-border">
                {(
                  [
                    ["machines", "Machines", Pickaxe],
                    ["ground", "Ground", Mountain],
                    ["crew", "Crew", Users],
                  ] as const
                ).map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    className={`inline-flex h-12 flex-1 items-center justify-center gap-2 font-display text-lg uppercase tracking-wide ${panel === id ? "bg-primary text-primary-fg" : "text-muted"}`}
                    onClick={() => setPanel(id)}
                  >
                    <Icon className="size-4" aria-hidden />
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-2">
                {panel === "crew" && <p className="border-b border-border py-3 text-sm leading-relaxed text-muted">Hire an operator for each machine you want running. Set Work source to Any leased source or choose a specific leased claim, such as Copper Bench.</p>}

                {panel === "machines" &&
                  hud.machines.map((m) => (
                    <article key={m.id} className="border-b border-border py-4">
                      <div className="flex items-baseline justify-between gap-3">
                        <h2 className="font-display text-2xl uppercase leading-none tracking-wide text-fg">{m.name}</h2>
                        <p className="text-sm text-cash">{m.owned ? "On the yard" : m.priceLabel}</p>
                      </div>
                      <p className="mt-2 text-sm leading-relaxed text-muted">{m.blurb}</p>
                      {!m.owned && (
                        <button
                          type="button"
                          disabled={!m.affordable}
                          className="mt-3 h-11 px-4 font-display text-lg uppercase tracking-wide bg-primary text-primary-fg disabled:opacity-40"
                          onClick={() => apiRef.current?.buy(m.id)}
                        >
                          Buy
                        </button>
                      )}
                    </article>
                  ))}
                {panel === "ground" &&
                  hud.grounds.map((g) => (
                    <article key={g.id} className="border-b border-border py-4">
                      <div className="flex items-baseline justify-between gap-3">
                        <h2 className="font-display text-2xl uppercase leading-none tracking-wide text-fg">{g.name}</h2>
                        <p className="text-sm text-cash">{g.owned ? "Leased" : g.priceLabel}</p>
                      </div>
                      <p className="mt-2 text-sm leading-relaxed text-muted">{g.blurb}</p>
                      {!g.owned && (
                        <button
                          type="button"
                          disabled={!g.affordable}
                          className="mt-3 h-11 px-4 font-display text-lg uppercase tracking-wide bg-primary text-primary-fg disabled:opacity-40"
                          onClick={() => apiRef.current?.buyGround(g.id)}
                        >
                          Lease
                        </button>
                      )}
                    </article>
                  ))}
                {panel === "crew" &&
                  hud.crew.map((c) => (
                    <article key={c.index} className="border-b border-border py-4">
                      <div className="flex items-baseline justify-between gap-3">
                        <h2 className="font-display text-2xl uppercase leading-none tracking-wide text-fg">{c.name}</h2>
                        <p className="text-sm text-muted">{c.cargo}</p>
                      </div>
                      <p className="mt-1 text-sm text-fg">{c.status}</p>
                      <label className="mt-3 flex flex-col gap-1 text-sm text-muted">
                        Work source
                        <select
                          className="h-11 border border-border bg-surface px-3 text-fg"
                          value={c.workClaim == null ? "any" : String(c.workClaim)}
                          disabled={!c.operator && !c.active}
                          onChange={(e) => apiRef.current?.assignSource(c.index, e.target.value === "any" ? null : Number(e.target.value))}
                        >
                          <option value="any">Any leased source</option>
                          {hud.grounds.filter((g) => g.owned).map((g) => (
                            <option key={g.id} value={g.id}>{g.name}</option>
                          ))}
                        </select>
                      </label>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="h-11 border border-border px-3 font-display text-lg uppercase tracking-wide text-fg"
                          onClick={() => {
                            apiRef.current?.drive(c.index);
                            setPanel(null);
                          }}
                        >
                          {c.active ? "Driving" : "Drive"}
                        </button>
                        <button
                          type="button"
                          disabled={!c.affordableHire}
                          className={`h-11 px-3 font-display text-lg uppercase tracking-wide disabled:opacity-40 ${c.operator ? "bg-primary text-primary-fg" : "border border-border text-fg"}`}
                          onClick={() => apiRef.current?.crew(c.index)}
                        >
                          {c.hireLabel}
                        </button>
                        {c.sellLabel && (
                          <button
                            type="button"
                            className="h-11 border border-border px-3 font-display text-lg uppercase tracking-wide text-fg"
                            onClick={() => apiRef.current?.sell(c.index)}
                          >
                            {c.sellLabel}
                          </button>
                        )}
                      </div>
                      <div className="mt-3 flex flex-col gap-2">
                        {c.upgrades.map((u) => (
                          <button
                            key={u.kind}
                            type="button"
                            disabled={u.costLabel == null || !u.affordable}
                            className="h-11 border border-border px-3 text-left text-sm text-fg disabled:opacity-40"
                            onClick={() => apiRef.current?.upgrade(c.index, u.kind as UpgradeKind)}
                          >
                            {u.label} {u.level}/3{u.costLabel ? ` · ${u.costLabel}` : " · Maxed"}
                          </button>
                        ))}
                      </div>
                    </article>
                  ))}
              </div>
              {hud.log.length > 0 && (
                <ul className="border-t border-border px-4 py-3 text-sm text-muted">
                  {hud.log.map((line, i) => (
                    <li key={`${line}-${i}`}>{line}</li>
                  ))}
                </ul>
              )}
            </aside>
          )}
        </>
      )}
    </main>
  );
}

function Joystick({ onChange }: { onChange: (steer: number, throttle: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  function fromEvent(e: React.PointerEvent) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const mag = Math.hypot(dx, dy);
    if (mag > 1) {
      dx /= mag;
      dy /= mag;
    }
    onChange(Math.max(-1, Math.min(1, -dx)), Math.max(-1, Math.min(1, -dy)));
  }
  return (
    <div
      ref={ref}
      className="pointer-events-auto relative h-32 w-32 rounded-full border border-border bg-surface"
      aria-label="Drive"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        fromEvent(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) fromEvent(e);
      }}
      onPointerUp={(e) => {
        onChange(0, 0);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => onChange(0, 0)}
    >
      <span className="absolute top-1/2 left-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" />
    </div>
  );
}
