import { fromUnits } from "./fullmetal";
import { suiRead } from "./sui";

export type InstState = {
  liquid: number; // treasury balance physically present
  reserved: number; // IM reserved across open contracts
  rehypothecated: number; // supplied to DeepBook
  totalRequired: number; // maintenance required
  equity: number; // liquid + rehypothecated
  available: number; // equity − reserved
};

/** Read an Institution's live accounting straight off the object fields
 *  (treasury/reserved/rehypothecated render as plain 6dp integer strings). */
export async function readInstitution(id: string): Promise<InstState> {
  const o = await suiRead.getObject({ id, options: { showContent: true } });
  const f = ((o.data?.content as { fields?: Record<string, string> } | undefined)?.fields ?? {});
  const liquid = fromUnits(f.treasury ?? "0");
  const reserved = fromUnits(f.reserved ?? "0");
  const rehypothecated = fromUnits(f.rehypothecated ?? "0");
  const totalRequired = fromUnits(f.total_required ?? "0");
  const equity = liquid + rehypothecated;
  return {
    liquid,
    reserved,
    rehypothecated,
    totalRequired,
    equity,
    available: Math.max(0, equity - reserved),
  };
}
