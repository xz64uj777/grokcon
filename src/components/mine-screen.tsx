import { useEffect, useRef, useState } from "react";
import { CircleDollarSign, Gauge, Mountain, Pickaxe, TrendingDown, TrendingUp, Minus, Users, Volume2, VolumeX, X } from "lucide-react";
import type { GameApi, UpgradeKind, ViewModel } from "@/game/types";
import { usDist } from "@/game/catalog";
import { BLAST_RADIUS } from "@/game/mining";
import { crewExplanation } from "@/game/crew-help";

export function MineScreen() {
  const worldRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<GameApi | null>(null);
  const bridges = useRef({ toggle: () => {}, close: () => {} });
  const [hud, setHud] = useState<ViewModel | null>(null);
  const [panel, setPanel] = useState<null | "machines" | "ground" | "crew" | "prices">(null);
  const [crewArea, setCrewArea] = useState<"ridge" | "river" | "mountain">("ridge");
  const [watchMap, setWatchMap] = useState<"ridge" | "river" | "mountain" | null>(null);
  const [company, setCompany] = useState("Ridge Ore Co.");
  const [seeded, setSeeded] = useState(false);
  const [booksNote, setBooksNote] = useState("");
  const [wipe, setWipe] = useState(false);
  const twin = useRef({ left: { x: 0, y: 0 }, right: { x: 0, y: 0 } });
  const padRef = useRef<HTMLDivElement>(null);
  const [padH, setPadH] = useState(0);
  const twoSticks = hud?.twoSticks ?? false;
  const screen = useScreenShape();
  // Info card: one compact line while driving; full card when stopped or tapped open.
  const [cardOpen, setCardOpen] = useState(false);
  const [settled, setSettled] = useState(true);
  const moving = hud?.moving ?? false;
  useEffect(() => {
    // Small delay so the card doesn't flicker on every tiny stop/start.
    const t = window.setTimeout(() => setSettled(!moving), moving ? 250 : 700);
    return () => window.clearTimeout(t);
  }, [moving]);
  useEffect(() => {
    if (moving) return;
    setCardOpen(false);
  }, [moving]);
  const compact = !settled && !cardOpen;
  useEffect(() => {
    // Folding, unfolding or rotating swaps the whole control layout. Let go of
    // every stick and button so nothing stays stuck "held" in the new layout.
    apiRef.current?.releaseInput();
    twin.current = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  }, [screen]);
  const playingNow = hud?.mode === "play";
  useEffect(() => {
    // Keep the machine card just above the sticks and buttons, whatever their height.
    const el = padRef.current;
    if (!el) return;
    const measure = () => setPadH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [twoSticks, playingNow, screen]);

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
    <main className={`game-shell fixed inset-0 bg-bg text-fg ${hud?.twoSticks ? "twin-sticks" : ""} ${playing && hud?.photo ? "photo-mode" : ""}`} data-screen={screen} style={{ ["--pad-h" as string]: `${padH}px` }}>
      <div ref={worldRef} className="absolute inset-0" />
      {playing && hud?.ripperControl && !hud.photo && (
        <RipperDrag depth={hud.ripper} onChange={(d) => apiRef.current?.setRipper(d)} />
      )}
      {playing && hud?.photo && (
        <button type="button" className="photo-exit pointer-events-auto absolute right-3 bottom-3 z-30 h-11 min-w-11 border border-border bg-surface/80 px-4 font-display text-lg uppercase" onClick={() => apiRef.current?.ops("photo")}>
          Done
        </button>
      )}
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
            The books save on this phone. Download a copy before you switch devices.
          </p>
        </section>
      )}
      {playing && hud && (
        <>
          <header className="hud-top pointer-events-none absolute inset-x-0 top-0 z-10 p-3 md:p-4">
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
                <p className="text-[10px] uppercase tracking-widest text-cash">Good next move</p>
                <p className="font-display text-lg uppercase leading-tight tracking-wide text-fg">{hud.objective}</p>
                {hud.contractLabel && <p className="mt-1 text-sm text-cash">{hud.contractLabel}</p>}
                <p className="mt-1 text-sm text-muted">{hud.shift}</p>
              </div>
              <button
                type="button"
                className="desk-only pointer-events-auto ml-auto inline-flex h-11 items-center border border-border bg-surface px-3 font-display text-base uppercase tracking-wide text-fg"
                aria-label="Switch controls"
                onClick={(e) => {
                  e.currentTarget.blur();
                  apiRef.current?.setControlMode(hud.controlMode === "real" ? "simple" : "real");
                }}
              >
                {hud.controlMode === "real" ? "Realistic" : "Simple"}
              </button>
              <button
                type="button"
                className={`desk-only pointer-events-auto inline-flex h-11 items-center border px-3 font-display text-base uppercase tracking-wide ${hud.practice ? "border-primary bg-primary text-primary-fg" : "border-border bg-surface text-fg"}`}
                onClick={(e) => {
                  e.currentTarget.blur();
                  setPanel(null);
                  apiRef.current?.practice(!hud.practice);
                }}
              >
                {hud.practice ? "Leave practice" : "Practice"}
              </button>
              <button
                type="button"
                className={`pointer-events-auto inline-flex h-11 items-center border px-3 font-display text-lg uppercase tracking-wide ${hud.watching ? "border-primary bg-primary text-primary-fg" : "border-border bg-surface text-fg"}`}
                onClick={() => {
                  if (!hud.watching) setWatchMap(hud.area);
                  apiRef.current?.watch(!hud.watching);
                }}
              >
                {hud.watching ? "Watching" : "Watch"}
              </button>
              <button
                type="button"
                className="pointer-events-auto ml-auto inline-flex h-11 items-center gap-2 border border-border bg-surface px-3 font-display text-lg uppercase tracking-wide text-fg min-[821px]:ml-0"
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
          {(hud.practice || hud.blastLabel || hud.bridgeClock || hud.bridgeLabel.endsWith("TOO HEAVY") || hud.groundLabel.startsWith("Bogged")) && (
            <div className="hud-banner pointer-events-none absolute inset-x-0 top-16 z-10 flex flex-col items-center gap-2 px-3 md:top-20">
              {hud.practice && (
                <p className="border border-primary bg-surface px-3 py-1 font-display text-base uppercase tracking-wide text-primary">Practice yard · nothing here counts or saves</p>
              )}
              {hud.blastLabel && (
                <p className="border border-red-500 bg-red-950/90 px-3 py-2 text-center font-display text-lg uppercase tracking-wide text-red-100">{hud.blastLabel}</p>
              )}
              {hud.bridgeClock && (
                <p className="border border-sky-400 bg-sky-950/90 px-3 py-1 text-center font-display text-base uppercase tracking-wide text-sky-100">{hud.bridgeClock}</p>
              )}
              {!hud.blastLabel && !hud.bridgeClock && hud.bridgeLabel.endsWith("TOO HEAVY") && (
                <p className="border border-red-500 bg-red-950/90 px-3 py-1 text-center font-display text-base uppercase tracking-wide text-red-100">{hud.bridgeLabel}</p>
              )}
              {!hud.blastLabel && hud.groundLabel.startsWith("Bogged") && (
                <p className="border border-cash bg-surface/95 px-3 py-1 text-center font-display text-base uppercase tracking-wide text-cash">{hud.groundLabel}</p>
              )}
            </div>
          )}
          <footer className={`hud-foot pointer-events-none absolute inset-x-0 z-10 px-3 py-2 ${compact ? "is-compact" : ""}`}>
            <div
              role="button"
              tabIndex={0}
              aria-expanded={!compact}
              aria-label={compact ? "Show machine details" : "Machine details"}
              className="hud-card pointer-events-auto max-w-md border border-border bg-surface/95 px-3 py-2"
              onPointerUp={() => setCardOpen((o) => !o)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setCardOpen((o) => !o);
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <p className="font-display text-lg uppercase leading-none tracking-wide text-fg">{hud.vehicleName}</p>
                <p className="flex shrink-0 items-center gap-1 text-sm text-muted">
                  {!compact && <Gauge className="size-4" aria-hidden />}
                  {hud.speedLabel}
                </p>
              </div>
              {compact && (
                <p className="mt-1 truncate text-xs text-fg">
                  {hud.cargoLabel.replace(/^Empty · /, "0 / ")}
                  {hud.purityLabel && <span className="text-cash"> · {hud.purityLabel}</span>}
                </p>
              )}
              {!compact && (
              <div>
              <p className="mt-0.5 text-sm text-fg">
                {hud.cargoLabel}
                {hud.purityLabel && <span className="text-cash"> · {hud.purityLabel}</span>}
              </p>
              {hud.toolLabel && <p className="text-xs text-muted">{hud.toolLabel}</p>}
              {hud.faceLabel && <p className="text-xs text-fg">{hud.faceLabel}</p>}
              {(hud.area !== "ridge" || hud.areaName === "North road" || hud.rain > 0.05) && (
                <p className="area-line text-xs text-muted">
                  {hud.areaName} · {hud.weatherLabel}
                  {hud.groundLabel && !hud.groundLabel.startsWith("Bogged") ? ` · ${hud.groundLabel}` : ""}
                </p>
              )}
              {hud.passLabel && <p className="text-xs text-cash">{hud.passLabel}</p>}
              {hud.routeLabel && <p className="text-xs text-cash">{hud.routeLabel}</p>}
              {hud.bridgeLabel && !hud.bridgeLabel.endsWith("TOO HEAVY") && <p className="text-xs text-fg">{hud.bridgeLabel}</p>}
              {hud.opsLine && <p className="text-xs leading-snug text-fg [overflow-wrap:anywhere]">{hud.opsLine}</p>}
              <div className="mt-1 h-1.5 bg-bg">
                <div className="h-full bg-primary" style={{ width: `${Math.round(hud.cargoFrac * 100)}%` }} />
              </div>
              <p className="hud-hint mt-1 text-xs leading-snug text-muted">{hud.hint}</p>
              <div className="next-move-phone mt-2 border-t border-border pt-2">
                <p className="text-[10px] uppercase tracking-widest text-cash">Good next move</p>
                <p className="text-xs leading-snug text-fg">{hud.objective}</p>
              </div>
              {hud.log[0] && <p className="hud-hint mt-0.5 line-clamp-2 text-xs leading-snug text-cash">{hud.log[0]}</p>}
              {hud.blastInfo && (
                <p className={`mt-1 border px-2 py-0.5 text-xs ${hud.canBlast ? "border-red-500 text-red-200" : "border-border text-muted"}`}>{hud.blastInfo}</p>
              )}
              </div>
              )}
            </div>
          </footer>
          {hud.watching ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 p-3 pb-4">
              <div className="pointer-events-auto flex items-stretch gap-2">
                <button
                  type="button"
                  className="h-20 shrink-0 bg-primary px-4 font-display text-xl uppercase tracking-wide text-primary-fg"
                  onClick={() => apiRef.current?.watch(false)}
                >
                  Sit
                </button>
                {hud.valleyOpen && (
                  <div className="flex shrink-0 flex-col gap-1">
                    {(
                      [
                        ["ridge", "Ridge"],
                        ["river", "Valley"],
                        ["mountain", "Mtn"],
                      ] as const
                    ).filter(([id]) => id !== "mountain" || hud.mountainOpen).map(([id, label]) => {
                      const n = hud.crew.filter((c) => c.area === id).length;
                      const on = (watchMap ?? hud.area) === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          className={`h-9 w-[4.5rem] font-display text-xs uppercase tracking-wide ${on ? "bg-primary text-primary-fg" : "border border-border bg-surface text-fg"}`}
                          onClick={() => {
                            setWatchMap(id);
                            const first = hud.crew.find((c) => c.area === id);
                            if (first) apiRef.current?.look(first.index);
                          }}
                        >
                          {label} {n}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
                  {hud.crew.filter((c) => c.area === (watchMap ?? hud.area)).length === 0 && (
                    <p className="flex h-20 items-center px-2 text-sm text-muted">No machines on this map.</p>
                  )}
                  {hud.crew
                    .filter((c) => c.area === (watchMap ?? hud.area))
                    .map((c) => (
                    <button
                      key={c.index}
                      type="button"
                      className={`h-20 w-40 shrink-0 border px-2 text-left ${c.active ? "border-primary bg-primary text-primary-fg" : "border-border bg-surface text-fg"}`}
                      onClick={() => apiRef.current?.look(c.index)}
                    >
                      <span className="block truncate font-display text-base uppercase leading-none tracking-wide">{c.name}</span>
                      <span className="mt-1 block truncate text-xs">{c.operator ? c.status || "On duty" : "Off shift"}</span>
                      <span className="mt-0.5 block truncate text-xs opacity-80">{c.cargo}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : hud.twoSticks ? (
            <div ref={padRef} key={`twin-${screen}`} className="twin-pad pointer-events-none absolute inset-x-0 bottom-0 z-10 gap-2 p-3 pb-4">
              <div className="twin-btns pointer-events-auto flex flex-wrap content-end justify-center gap-2">
                <SmallBtn onClick={() => apiRef.current?.cycle(1)}>Next</SmallBtn>
                <SmallBtn onClick={() => apiRef.current?.loadTruck()}>{hud.deckButton ?? "Load"}</SmallBtn>
                {hud.machineId === "excavator" && (
                  <SmallBtn active={hud.excDrive} onClick={() => apiRef.current?.toggleExcDrive()}>{hud.excDrive ? "Park on" : "Park"}</SmallBtn>
                )}
                {hud.canTest && <SmallBtn onClick={() => apiRef.current?.testHole()}>Test hole</SmallBtn>}
                {hud.canBlast && <SmallBtn danger onClick={() => apiRef.current?.blast()}>Blast</SmallBtn>}
                {hud.field.map((f) => (
                  <SmallBtn key={f.id} onClick={() => apiRef.current?.ops(f.id)}>{f.label}</SmallBtn>
                ))}
                <button
                  type="button"
                  className="h-11 min-w-16 bg-primary px-4 font-display text-lg uppercase tracking-wide text-primary-fg"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    apiRef.current?.setAction(true);
                  }}
                  onPointerUp={() => apiRef.current?.setAction(false)}
                  onPointerCancel={() => apiRef.current?.setAction(false)}
                >
                  Auto
                </button>
              </div>
              <div className="twin-l">
                <TwinStick label={hud.help.phoneLeft} onChange={(x, y) => { twin.current.left = { x, y }; apiRef.current?.setSticks(twin.current.left, twin.current.right); }} />
              </div>
              <div className="twin-r">
                <TwinStick label={hud.help.phoneRight} onChange={(x, y) => { twin.current.right = { x, y }; apiRef.current?.setSticks(twin.current.left, twin.current.right); }} />
              </div>
            </div>
          ) : (
          <div ref={padRef} key={`one-${screen}`} className="touch-ui pointer-events-none absolute inset-x-0 bottom-0 z-10 items-end justify-between p-4 pb-6">
              <Joystick onChange={(steer, throttle) => apiRef.current?.setStick(steer, throttle)} />
              <div className="pointer-events-auto flex flex-col items-end gap-2">
                {hud.canTest && <SmallBtn onClick={() => apiRef.current?.testHole()}>Test hole</SmallBtn>}
                {hud.canBlast && <SmallBtn danger onClick={() => apiRef.current?.blast()}>Blast</SmallBtn>}
                {hud.field.map((f) => (
                  <SmallBtn key={f.id} onClick={() => apiRef.current?.ops(f.id)}>{f.label}</SmallBtn>
                ))}
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
                  {hud.deckButton ?? "Load"}
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
          )}
          {panel && (
            <aside className="office-panel absolute inset-y-0 right-0 z-20 flex w-full max-w-md flex-col border-l border-border bg-surface">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div>
                  <p className="font-display text-2xl uppercase leading-none tracking-wide text-fg">{hud.officeTitle}</p>
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
                    ["prices", "Prices", CircleDollarSign],
                  ] as const
                ).map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    className={`inline-flex h-12 flex-1 items-center justify-center gap-1 font-display text-base uppercase tracking-wide md:gap-2 md:text-lg ${panel === id ? "bg-primary text-primary-fg" : "text-muted"}`}
                    onClick={() => {
                      setPanel(id);
                      if (id === "crew") setCrewArea(hud.area);
                    }}
                  >
                    <Icon className="size-4" aria-hidden />
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2 border-b border-border px-4 py-2">
                <button
                  type="button"
                  className="h-11 flex-1 border border-border px-2 font-display text-base uppercase tracking-wide text-fg"
                  onClick={() => apiRef.current?.setControlMode(hud.controlMode === "real" ? "simple" : "real")}
                >
                  Controls: {hud.controlMode === "real" ? "Realistic" : "Simple"}
                </button>
                <button
                  type="button"
                  className={`h-11 flex-1 border px-2 font-display text-base uppercase tracking-wide ${hud.practice ? "border-primary bg-primary text-primary-fg" : "border-border text-fg"}`}
                  onClick={() => {
                    setPanel(null);
                    apiRef.current?.practice(!hud.practice);
                  }}
                >
                  {hud.practice ? "Leave practice" : "Practice yard"}
                </button>
              </div>
              {!hud.practice && (
                <div className="travel-row border-b border-border px-4 py-2">
                  <p className="text-xs uppercase tracking-wide text-muted">
                    You're at <span className="text-fg">{hud.areaName}</span>
                  </p>
                  {hud.valleyOpen ? (
                    <div className="mt-1 flex gap-2">
                      <button
                        type="button"
                        disabled={!hud.canHaul}
                        aria-label="Haul this machine"
                        className={`min-h-11 flex-1 border px-2 py-1 text-left text-sm leading-tight ${hud.canHaul ? "border-primary text-fg" : "border-border text-muted"}`}
                        onClick={() => {
                          apiRef.current?.haul();
                          setPanel(null);
                        }}
                      >
                        {hud.travelLabel}
                      </button>
                      {hud.canGoOther && (
                        <button
                          type="button"
                          className="min-h-11 border border-border px-3 font-display text-base uppercase tracking-wide text-fg"
                          onClick={() => {
                            apiRef.current?.goOther();
                            setPanel(null);
                          }}
                        >
                          Go to {hud.otherAreaName}
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="mt-1 text-sm text-muted">{hud.travelLabel}.</p>
                  )}
                  {hud.mountainHaul && (
                    <button
                      type="button"
                      disabled={!hud.canHaulMountain}
                      className={`mt-2 min-h-11 w-full border px-2 py-1 text-left text-sm leading-tight ${hud.canHaulMountain ? "border-primary text-fg" : "border-border text-muted"}`}
                      onClick={() => {
                        apiRef.current?.haul("mountain");
                        setPanel(null);
                      }}
                    >
                      {hud.mountainHaul}
                    </button>
                  )}
                </div>
              )}
              <div className="flex-1 overflow-y-auto px-4 py-2">
                {panel === "crew" && (
                  <div className="border-b border-border py-3">
                    <p className="text-sm leading-relaxed text-muted">Each map has its own crew. Hire an operator for each machine you want running on that yard. Tap Watch to step out of the seat: they keep working, and you can tap a machine to follow it. Set Work source to Any leased source or choose a claim on that map, such as Copper Bench.</p>
                    {hud.valleyOpen && (
                      <div className="mt-3 flex gap-2">
                        {(
                          [
                            ["ridge", "Ridge pit"],
                            ["river", "Valley"],
                            ["mountain", "Mountain"],
                          ] as const
                        ).filter(([id]) => id !== "mountain" || hud.mountainOpen).map(([id, label]) => {
                          const n = hud.crew.filter((c) => c.area === id).length;
                          return (
                            <button
                              key={id}
                              type="button"
                              className={`h-11 flex-1 font-display text-base uppercase tracking-wide ${crewArea === id ? "bg-primary text-primary-fg" : "border border-border text-fg"}`}
                              onClick={() => setCrewArea(id)}
                            >
                              {label} · {n}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {hud.sluice && crewArea === "ridge" && (
                      <button
                        type="button"
                        className={`mt-3 h-11 px-3 font-display text-lg uppercase tracking-wide ${hud.preferSluice ? "bg-primary text-primary-fg" : "border border-border text-fg"}`}
                        onClick={() => apiRef.current?.setHaulSluice(!hud.preferSluice)}
                      >
                        {hud.preferSluice ? "Sluice haul on" : "Sluice haul off"}
                      </button>
                    )}
                    {hud.sluice && crewArea === "ridge" && (
                      <p className="mt-2 text-sm leading-relaxed text-muted">On: copper and gold always go to the sluice. They pay more there. Iron stays on the crusher.</p>
                    )}
                  </div>
                )}

                {panel === "prices" && (
                  <div className="py-3">
                    <p className="text-sm text-cash">{hud.dayLabel}</p>
                    <p className="mt-1 text-sm leading-relaxed text-muted">Prices move every day, from half to double the normal price. Clean ore pays its purity: 90% pure gets 90% of the price. Selling a lot in one spot on one day dips that price a little.</p>
                    {hud.prices.map((row) => (
                      <article key={row.ore} className="border-b border-border py-3">
                        <h2 className="font-display text-xl uppercase leading-none tracking-wide text-fg">{row.name}</h2>
                        <ul className="mt-2 space-y-1">
                          {row.spots.map((spot) => (
                            <li key={spot.pad} className="flex items-center justify-between gap-2 text-sm">
                              <span className="text-muted">{spot.name}</span>
                              <span className="flex items-center gap-2 text-fg">
                                {spot.price}
                                <span className={`inline-flex items-center gap-1 ${spot.trend === "up" ? "text-emerald-400" : spot.trend === "down" ? "text-red-400" : "text-muted"}`}>
                                  {spot.trend === "up" ? <TrendingUp className="size-4" aria-label="rising" /> : spot.trend === "down" ? <TrendingDown className="size-4" aria-label="falling" /> : <Minus className="size-4" aria-label="steady" />}
                                  {spot.pct}%
                                </span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </article>
                    ))}
                  </div>
                )}
                {panel === "machines" && (
                  <article className="border-b border-border py-4">
                    <h2 className="font-display text-2xl uppercase leading-none tracking-wide text-fg">Blasting</h2>
                    <p className="mt-2 text-sm leading-relaxed text-muted">
                      Pull up to a face and press Blast. Each blast costs a flat $750, paid when drilling starts. Each face can be blasted once a day. The drill rig stays on the face. You can drive off as soon as it starts. Get every machine {usDist(BLAST_RADIUS)} back before the charges go. You have about 26 seconds.
                    </p>
                  </article>
                )}
                {panel === "machines" && (hud.shop.length > 0 || hud.records.length > 0) && (
                  <article className="border-b border-border py-4">
                    <h2 className="font-display text-2xl uppercase leading-none tracking-wide text-fg">Site</h2>
                    {hud.opsLine && <p className="mt-2 text-sm text-muted">{hud.opsLine}</p>}
                    {hud.shop.map((b) => (
                      <div key={b.id} className="mt-3">
                        <p className="text-sm leading-relaxed text-muted">{b.detail}</p>
                        <button type="button" disabled={!b.enabled} className="mt-2 h-11 px-4 font-display text-lg uppercase tracking-wide bg-primary text-primary-fg disabled:opacity-40" onClick={() => apiRef.current?.ops(b.id)}>
                          {b.label}
                        </button>
                      </div>
                    ))}
                    {hud.records.length > 0 && (
                      <ul className="mt-3 space-y-1 text-sm text-fg">
                        {hud.records.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    )}
                  </article>
                )}
                {panel === "machines" &&
                  hud.machines.map((m) => (
                    <article key={m.id} className="border-b border-border py-4">
                      <div className="flex items-baseline justify-between gap-3">
                        <h2 className="font-display text-2xl uppercase leading-none tracking-wide text-fg">{m.name}</h2>
                        <p className="text-sm text-cash">{m.priceLabel}</p>
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
                  hud.grounds.filter((g) => g.here).map((g) => (
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
                {panel === "crew" && (
                  <section className="border-b border-border py-4">
                    <h2 className="font-display text-xl uppercase tracking-wide text-fg">Automation settings</h2>
                    <div className="mt-3 border-t border-border pt-3">
                      <h3 className="font-display text-lg uppercase tracking-wide text-fg">Crew shift</h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted">Pause or resume hired operators everywhere. This does not hire or fire anyone.</p>
                      <button
                        type="button"
                        disabled={!hud.crew.some((c) => c.hired)}
                        className="mt-2 h-11 bg-primary px-3 font-display text-lg uppercase tracking-wide text-primary-fg disabled:opacity-40"
                        onClick={() => apiRef.current?.setCrewDuty(!hud.crew.some((c) => c.hired && c.operator))}
                      >
                        {hud.crew.some((c) => c.hired && c.operator) ? "Pause all operators" : "Resume all operators"}
                      </button>
                    </div>
                    <div className="mt-3 border-t border-border pt-3">
                      <h3 className="font-display text-lg uppercase tracking-wide text-fg">Plant stockpile feeders</h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted">Choose how many hired loaders, excavators, or skid steers work material dumped at a plant.</p>
                      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Plant stockpile feeder limit">
                        {([
                          { value: 1, label: "1 machine" },
                          { value: 2, label: "2 machines" },
                          { value: "all", label: "All" },
                        ] as const).map((choice) => (
                          <button
                            key={choice.value}
                            type="button"
                            aria-pressed={hud.feedLimit === choice.value}
                            className={`h-11 border px-3 font-display text-lg uppercase tracking-wide ${hud.feedLimit === choice.value ? "border-primary bg-primary text-primary-fg" : "border-border text-fg"}`}
                            onClick={() => apiRef.current?.setFeedLimit(choice.value)}
                          >
                            {choice.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="mt-3 border-t border-border pt-3">
                      <h3 className="font-display text-lg uppercase tracking-wide text-fg">Plant truck deliveries</h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted">Limit how many hired, loaded dump trucks approach each plant at once. Trucks already delivering finish their trip.</p>
                      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Plant truck delivery limit">
                        {([
                          { value: 1, label: "1 truck" },
                          { value: 2, label: "2 trucks" },
                          { value: "all", label: "All" },
                        ] as const).map((choice) => (
                          <button
                            key={choice.value}
                            type="button"
                            aria-pressed={hud.truckLimit === choice.value}
                            className={`h-11 border px-3 font-display text-lg uppercase tracking-wide ${hud.truckLimit === choice.value ? "border-primary bg-primary text-primary-fg" : "border-border text-fg"}`}
                            onClick={() => apiRef.current?.setTruckLimit(choice.value)}
                          >
                            {choice.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </section>
                )}
                {panel === "crew" && hud.crew.filter((c) => c.area === (hud.valleyOpen ? crewArea : "ridge")).length === 0 && (
                  <p className="py-4 text-sm text-muted">
                    {crewArea === "mountain" ? "No machines on the mountain. Haul one up on the lowboy." : crewArea === "river" ? "No machines in River Valley. Haul one over on the lowboy." : "No machines at Ridge pit."}
                  </p>
                )}
                {panel === "crew" &&
                  hud.crew.filter((c) => c.area === (hud.valleyOpen ? crewArea : "ridge")).map((c) => {
                    const explanation = crewExplanation(c);
                    const lowboyAssignment = c.sources[0]?.value.startsWith("map:") ?? false;
                    return (
                    <article key={c.index} className="border-b border-border py-4">
                      <div className="flex items-baseline justify-between gap-3">
                        <h2 className="font-display text-2xl uppercase leading-none tracking-wide text-fg">{c.name}</h2>
                        <p className="text-sm text-muted">{c.cargo}</p>
                      </div>
                      {c.where && <p className="mt-1 text-sm text-muted">{c.where}</p>}
                      <p className="mt-1 text-sm text-fg">{c.status}</p>
                      {explanation && <p className="mt-1 text-sm leading-relaxed text-cash">{explanation}</p>}
                      {c.damageLabel && <p className="mt-1 text-sm text-red-400">{c.damageLabel} · slower until fixed</p>}
                      <label className="mt-3 flex flex-col gap-1 text-sm text-muted">
                        {lowboyAssignment ? "Haul to" : "Work source"}
                        <select
                          className="h-11 border border-border bg-surface px-3 text-fg"
                          value={c.workSource}
                          disabled={!c.operator && !c.active}
                          onChange={(e) => apiRef.current?.assignSource(c.index, e.target.value === "any" ? null : e.target.value)}
                        >
                          <option value="any">{lowboyAssignment ? "No haul" : "Any leased source"}</option>
                          {c.sources.map((g) => (
                            <option key={g.value} value={g.value}>{g.label}</option>
                          ))}
                        </select>
                      </label>
                      <p className="mt-1 text-xs leading-relaxed text-muted">
                        {lowboyAssignment
                          ? "On duty, the lowboy picks up parked, empty machines assigned to this map, if they fit its deck."
                          : "This choice affects only this machine. Any leased source lets it choose a suitable job; select a lease or face to keep it focused."}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={c.where === "On the lowboy"}
                          className="h-11 border border-border px-3 font-display text-lg uppercase tracking-wide text-fg disabled:opacity-40"
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
                        {c.repairLabel && (
                          <button
                            type="button"
                            disabled={!c.affordableRepair}
                            className="h-11 border border-red-500 px-3 font-display text-lg uppercase tracking-wide text-fg disabled:opacity-40"
                            onClick={() => apiRef.current?.repair(c.index)}
                          >
                            {c.repairLabel}
                          </button>
                        )}
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
                    );
                  })}
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
      className="drive-stick pointer-events-auto relative rounded-full border border-border bg-surface"
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

function SmallBtn({ children, onClick, active = false, danger = false, label }: { children: React.ReactNode; onClick: () => void; active?: boolean; danger?: boolean; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      className={`h-11 min-w-14 border px-3 font-display text-base uppercase tracking-wide ${active ? "border-primary bg-primary text-primary-fg" : danger ? "border-red-500 bg-red-950/90 text-red-100" : "border-border bg-surface text-fg"}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A big free-moving thumb stick. Reports x (right +) and y (forward +). */
function TwinStick({ label, onChange }: { label: string; onChange: (x: number, y: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
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
    setKnob({ x: dx, y: dy });
    onChange(dx, -dy);
  }
  function release() {
    setKnob({ x: 0, y: 0 });
    onChange(0, 0);
  }
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        ref={ref}
        className="twin-stick pointer-events-auto relative touch-none rounded-full border border-border bg-surface/90"
        aria-label={label}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          fromEvent(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) fromEvent(e);
        }}
        onPointerUp={(e) => {
          release();
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={release}
      >
        <span className="absolute inset-x-1/2 top-2 bottom-2 w-px bg-border" />
        <span className="absolute inset-y-1/2 left-2 right-2 h-px bg-border" />
        <span
          className="absolute h-[34%] w-[34%] rounded-full bg-primary"
          style={{ left: `${50 + knob.x * 33}%`, top: `${50 + knob.y * 33}%`, transform: "translate(-50%, -50%)" }}
        />
      </div>
      <p className="max-w-40 rounded bg-surface/80 px-1 text-center text-xs text-fg">{label}</p>
    </div>
  );
}

export type ScreenShape = "cover" | "phone-land" | "inner" | "inner-land";

/** Which screen we are on: folded cover (narrow), phone sideways, or the big unfolded inner screen. */
function readShape(): ScreenShape {
  if (typeof window === "undefined") return "cover";
  const vv = window.visualViewport;
  const w = vv?.width ?? window.innerWidth;
  const h = vv?.height ?? window.innerHeight;
  const short = Math.min(w, h);
  if (short >= 600) return w > h ? "inner-land" : "inner";
  return w > h ? "phone-land" : "cover";
}

function useScreenShape() {
  const [shape, setShape] = useState<ScreenShape>(readShape);
  useEffect(() => {
    const update = () => setShape(readShape());
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);
  return shape;
}

/** Drag the ripper arm down to put the shank in the ground; drag up to lift it. */
function RipperDrag({ depth, onChange }: { depth: number; onChange: (d: number) => void }) {
  const set = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onChange(Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
  };
  return (
    <div className="pointer-events-auto absolute right-2 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-1">
      <span className="bg-surface/90 px-1 font-display text-xs uppercase tracking-wide text-fg">Ripper</span>
      <div
        role="slider"
        aria-label="Ripper arm"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(depth * 100)}
        tabIndex={0}
        className="relative h-36 w-12 touch-none border border-border bg-surface/80"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          set(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons || e.pointerType === "touch") set(e);
        }}
      >
        <div className="absolute inset-x-0 top-0 bg-primary/30" style={{ height: `${depth * 100}%` }} />
        <div className="absolute inset-x-1 h-11 border border-primary bg-primary" style={{ top: `calc(${depth * 100}% - ${depth * 44}px)` }} />
      </div>
      <span className="bg-surface/90 px-1 text-[10px] text-muted">{depth >= 0.5 ? "In ground" : "Raised"}</span>
    </div>
  );
}
