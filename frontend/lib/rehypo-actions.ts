"use client";

import { useCallback } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";

import {
  CLOCK,
  DBUSDC_TYPE,
  DEEPBOOK,
  SHARED,
  SPCX,
  TARGET,
  toUnits,
} from "./fullmetal";
import { useSponsoredExecute } from "./sponsored";
import { loadInstitution } from "./store";

/** Supply liquid IM to the DeepBook DBUSDC margin pool (admin, gasless). */
export function useRehypothecate() {
  const account = useCurrentAccount();
  const exec = useSponsoredExecute();
  return useCallback(
    async (amount: number): Promise<string> => {
      const rec = account && loadInstitution(account.address);
      if (!rec) throw new Error("No institution.");
      return exec((tx) => {
        tx.moveCall({
          target: TARGET.rehypo.rehypothecate,
          typeArguments: [DBUSDC_TYPE],
          arguments: [
            tx.object(rec.institutionId),
            tx.object(rec.adminCapId),
            tx.object(DEEPBOOK.dbusdcMarginPool),
            tx.object(DEEPBOOK.marginRegistry),
            tx.pure.u64(toUnits(amount)),
            tx.object(CLOCK),
          ],
        });
      });
    },
    [account, exec],
  );
}

/** Withdraw supplied collateral back to the treasury (admin, gasless). */
export function useRecall() {
  const account = useCurrentAccount();
  const exec = useSponsoredExecute();
  return useCallback(
    async (amount: number): Promise<string> => {
      const rec = account && loadInstitution(account.address);
      if (!rec) throw new Error("No institution.");
      return exec((tx) => {
        tx.moveCall({
          target: TARGET.rehypo.recall,
          typeArguments: [DBUSDC_TYPE],
          arguments: [
            tx.object(rec.institutionId),
            tx.object(rec.adminCapId),
            tx.object(DEEPBOOK.dbusdcMarginPool),
            tx.object(DEEPBOOK.marginRegistry),
            tx.pure.u64(toUnits(amount)),
            tx.object(CLOCK),
          ],
        });
      });
    },
    [account, exec],
  );
}

/** Permissionless risk-responsive recall once the SPCX oracle is latched.
 *  No AdminCap — anyone can crank it; gasless for the signed-in user. */
export function useRecallOnTrigger() {
  const account = useCurrentAccount();
  const exec = useSponsoredExecute();
  return useCallback(async (): Promise<string> => {
    const rec = account && loadInstitution(account.address);
    if (!rec) throw new Error("No institution.");
    return exec((tx) => {
      tx.moveCall({
        target: TARGET.rehypo.recallOnTrigger,
        typeArguments: [DBUSDC_TYPE],
        arguments: [
          tx.object(rec.institutionId),
          tx.object(DEEPBOOK.dbusdcMarginPool),
          tx.object(DEEPBOOK.marginRegistry),
          tx.object(SHARED.riskOracle),
          tx.pure.string(SPCX.symbol),
          tx.object(CLOCK),
        ],
      });
    });
  }, [account, exec]);
}
