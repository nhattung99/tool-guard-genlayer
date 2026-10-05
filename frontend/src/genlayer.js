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

function injectedProvider() {
  const ethereum = window.ethereum;
  if (!ethereum) return null;
  const list = Array.isArray(ethereum.providers) ? ethereum.providers : [];
  return list.find((item) => item?.isMetaMask) || ethereum;
}

function studioChainId() {
  return `0x${Number(CHAIN.id).toString(16)}`;
}

function readableWalletError(err) {
  const message = String(err?.message || err || "");
  if (/wallet_getSnaps|wallet_requestSnaps|corresponding handler/i.test(message)) {
    return new Error("This wallet cannot switch to GenLayer. Install MetaMask and connect again.");
  }
  if (err?.code === 4001) {
    return new Error("The wallet request was rejected.");
  }
  return err instanceof Error ? err : new Error(message || "Could not connect the wallet.");
}

async function ensureStudionet(provider) {
  const chainId = studioChainId();
  const current = await provider.request({ method: "eth_chainId" });
  if (String(current).toLowerCase() === chainId) return;

  const network = {
    chainId,
    chainName: CHAIN.name || "Genlayer Studio Network",
    rpcUrls: [...(CHAIN.rpcUrls?.default?.http || ["https://studio.genlayer.com/api"])],
    nativeCurrency: CHAIN.nativeCurrency || { name: "GEN Token", symbol: "GEN", decimals: 18 },
    blockExplorerUrls: CHAIN.blockExplorers?.default?.url ? [CHAIN.blockExplorers.default.url] : [],
  };

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  } catch (err) {
    const code = err?.code ?? err?.data?.originalError?.code;
    const message = String(err?.message || "");
    const missingChain = code === 4902 || /unrecognized chain|not been added|unknown chain/i.test(message);
    if (!missingChain) throw readableWalletError(err);
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [network],
    });
  }
}

export async function connectStudionet() {
  const provider = injectedProvider();
  if (!provider) {
    throw new Error("No browser wallet found. Install MetaMask and try again.");
  }
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const address = accounts?.[0];
    if (!address) {
      throw new Error("The wallet did not return an address.");
    }
    await ensureStudionet(provider);
    const writeClient = createClient({
      chain: studionet,
      account: address,
      provider,
    });
    return { address, writeClient, readClient: createReadClient() };
  } catch (err) {
    throw readableWalletError(err);
  }
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
