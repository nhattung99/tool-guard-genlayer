import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { ExecutionResult, TransactionStatus } from "genlayer-js/types";

const rawAddress = String(import.meta.env.VITE_CONTRACT_ADDRESS || "").trim();

export const CONTRACT_ADDRESS = /^0x[a-fA-F0-9]{40}$/.test(rawAddress) ? rawAddress : "";
export const CHAIN = studionet;

export function hasContract() {
  return CONTRACT_ADDRESS.length > 0;
}

export function createReadClient() {
  return createClient({ chain: studionet });
}

export async function connectStudionet() {
  const provider = window.ethereum;
  if (!provider) {
    throw new Error("No browser wallet found. Install MetaMask and try again.");
  }
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) {
    throw new Error("The wallet did not return an address.");
  }
  const writeClient = createClient({
    chain: studionet,
    account: address,
    provider,
  });
  await writeClient.connect("studionet");
  return { address, writeClient, readClient: createReadClient() };
}

export async function readRentalCount(readClient) {
  const value = await readClient.readContract({
    address: CONTRACT_ADDRESS,
    functionName: "get_rental_count",
    args: [],
  });
  return BigInt(String(value));
}

export async function readRental(readClient, rentalId) {
  return readClient.readContract({
    address: CONTRACT_ADDRESS,
    functionName: "get_rental",
    args: [String(rentalId)],
  });
}

export async function writeAndWait(writeClient, readClient, functionName, args, value = 0n) {
  const txHash = await writeClient.writeContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
    value,
  });
  const receipt = await readClient.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.ACCEPTED,
  });
  if (receipt?.txExecutionResultName === ExecutionResult.FINISHED_WITH_ERROR) {
    throw new Error("The contract rejected the transaction. Check your role, the rental status, and the GEN amount.");
  }
  return receipt;
}
