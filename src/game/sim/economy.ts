/** Ore prices, market keys, and contract payouts. */

import * as Ops from "@/game/ops";
import { MILL_PRICE } from "@/game/mountain";
import { ORES, formatMoney } from "@/game/catalog";
import { VALLEY_CLAIMS, BARGE_RATE } from "@/game/river";
import { marketKey, priceMult } from "@/game/market";
import type { GameState, OreId, PadKind } from "@/game/types";
import { log } from "./world.ts";


export const MARKET_PADS = ["crusher", "reclaim", "sluice", "loadout", "wash", "barge", "mill"] as const;

export const MARKET_KEYS = MARKET_PADS.flatMap((pad) => (Object.keys(ORES) as OreId[]).map((ore) => marketKey(pad, ore)));

/** Today's price per ton at a selling spot (normal price × the day's market move). */
export function unitPrice(ore: OreId, pad: PadKind, sluice: boolean, market?: GameState["market"]) {
  return basePrice(ore, pad, sluice) * priceMult(market, pad, ore);
}


export function basePrice(ore: OreId, pad: PadKind, sluice: boolean) {
  const o = ORES[ore];
  if (pad === "wash") return o.wash;
  if (pad === "barge") return Math.round(o.crusher * BARGE_RATE);
  if (pad === "loadout") return o.crusher;
  if (pad === "mill") return MILL_PRICE[ore];
  if (pad === "reclaim") return ore === "dirt" ? o.reclaim : Math.round(o.crusher * 0.4);
  if (pad === "sluice") {
    if (!sluice) return 0;
    if (ore === "gold" || ore === "copper" || ore === "dirt") return o.sluice;
    return o.crusher;
  }
  return o.crusher;
}


export type Plants = { sluice: boolean; washPlant: boolean };

/** Bonus price for a contract. Uses the pad the company can actually sell at. */

/** Bonus price for a contract. Uses the pad the company can actually sell at. */
export function contractUnit(ore: OreId, plants: Plants) {
  if (ore === "silver") return plants.washPlant ? ORES.silver.wash : ORES.silver.crusher;
  if (ore === "gold") return plants.sluice ? ORES.gold.sluice : ORES.gold.crusher;
  return ORES[ore].crusher;
}


export function rollContract(seq: number, claims: number[], plants: Plants): GameState["contract"] {
  const options: OreId[] = ["iron"];
  if (claims.includes(2)) options.push("copper");
  if (claims.includes(3)) options.push("gold");
  if (claims.includes(VALLEY_CLAIMS.bars)) options.push("silver");
  const ore = options[seq % options.length] ?? "iron";
  const need = (ore === "gold" ? 4 : ore === "copper" ? 6 : 8) + seq * 2;
  return { ore, delivered: 0, need, bonus: Math.round(need * contractUnit(ore, plants) * 0.5) };
}


export function repriceContract(state: GameState) {
  const c = state.contract;
  if (!c) return;
  c.bonus = Math.round(c.need * contractUnit(c.ore, state) * 0.5);
}


export function fillContract(state: GameState, ore: OreId, tons: number) {
  const contract = state.contract;
  if (!contract || contract.ore !== ore || tons <= 0) return 0;
  contract.delivered += tons;
  if (contract.delivered + 0.05 < contract.need) return 0;
  const bonus = Math.round(contract.bonus * Ops.contractMult(state));
  Ops.onContractFilled(state);
  state.cash += bonus;
  state.lifetime += bonus;
  state.contractSeq += 1;
  state.contract = rollContract(state.contractSeq, state.claims, state);
  log(state, `Contract filled. Bonus ${formatMoney(bonus)}. Next: ${state.contract.need} tons ${ORES[state.contract.ore].name}.`);
  return bonus;
}
