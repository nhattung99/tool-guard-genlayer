import { useEffect, useMemo, useState } from "react";
import {
  CHAIN,
  CONTRACT_ADDRESS,
  connectStudionet,
  createReadClient,
  hasContract,
  readRental,
  readRentalCount,
  asCalldataAddress,
  writeAndWait,
} from "./genlayer";
import {
  deadlineUnix,
  formatWeiToGen,
  isValidPayout,
  parseGenToWei,
  payoutWeiFromPercent,
  subtractWei,
} from "./money";

const CATEGORIES = ["Hand tools", "Electronics", "Bikes and motorbikes", "Camping gear", "Other"];
const DEPOSIT_CHIPS = ["1", "5", "10", "20", "50"];
const PAYOUT_PERCENTS = [10, 25, 50, 75];
const DEADLINES = [
  { days: 1, label: "1 day" },
  { days: 3, label: "3 days" },
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
];

const STATUS_LABEL = {
  AWAITING_HANDOVER: "Waiting for the owner to submit pre-handover photos",
  RENTED: "Rented",
  RETURN_REPORTED: "Return reported, waiting for the AI",
  RESOLVED: "Resolved",
  DISPUTED: "Not confident enough — clearer evidence needed",
  PAYOUT_FAILED: "Payout failed in part",
  EXPIRED_FORFEITED: "Overdue, deposit forfeited",
};

function sameAddress(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function asList(value) {
  if (Array.isArray(value)) return value.map(String);
  return [];
}

function UrlEditor({ label, urls, onChange }) {
  const update = (index, next) => {
    const copy = urls.slice();
    copy[index] = next;
    onChange(copy);
  };
  return (
    <div className="urls">
      <span>{label}</span>
      {urls.map((url, index) => (
        <div className="url-row" key={`${label}-${index}`}>
          <input
            value={url}
            placeholder="https://..."
            onChange={(event) => update(index, event.target.value)}
          />
          <button
            type="button"
            onClick={async () => {
              const text = await navigator.clipboard.readText();
              update(index, text.trim());
            }}
          >
            Paste
          </button>
          {urls.length > 1 ? (
            <button type="button" onClick={() => onChange(urls.filter((_, i) => i !== index))}>
              Remove
            </button>
          ) : null}
        </div>
      ))}
      <button type="button" className="ghost" onClick={() => onChange(urls.concat(""))}>
        Add link
      </button>
    </div>
  );
}

function settlementText(rental) {
  const deposit = BigInt(String(rental.deposit_amount || "0"));
  const payout = BigInt(String(rental.damaged_payout_to_owner || "0"));
  const refund = subtractWei(deposit, payout);
  if (rental.status === "EXPIRED_FORFEITED" || (rental.status === "PAYOUT_FAILED" && !rental.verdict)) {
    return `The owner receives the full deposit of ${formatWeiToGen(deposit)} GEN if the transfer succeeds.`;
  }
  if (rental.verdict === "DAMAGED") {
    return `The owner receives ${formatWeiToGen(payout)} GEN. The renter receives ${formatWeiToGen(refund)} GEN back.`;
  }
  if (rental.verdict === "NO_DAMAGE") {
    return `The renter receives the full deposit of ${formatWeiToGen(deposit)} GEN back.`;
  }
  return `If there is no damage, the renter receives ${formatWeiToGen(deposit)} GEN. If there is damage, the owner receives ${formatWeiToGen(payout)} GEN and the renter receives ${formatWeiToGen(refund)} GEN.`;
}

export default function App() {
  const contractReady = hasContract();
  const [account, setAccount] = useState("");
  const [writeClient, setWriteClient] = useState(null);
  const [rentals, setRentals] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loadingList, setLoadingList] = useState(false);
  const [busy, setBusy] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState("");
  const [depositText, setDepositText] = useState("5");
  const [payoutPercent, setPayoutPercent] = useState(25);
  const [customPayout, setCustomPayout] = useState("");
  const [useCustomPayout, setUseCustomPayout] = useState(false);
  const [days, setDays] = useState(7);
  const [preUrls, setPreUrls] = useState({});
  const [postUrls, setPostUrls] = useState({});
  const [refUrls, setRefUrls] = useState({});

  const depositWei = useMemo(() => parseGenToWei(depositText), [depositText]);
  const payoutWei = useMemo(() => {
    if (useCustomPayout) return parseGenToWei(customPayout);
    return payoutWeiFromPercent(depositWei, payoutPercent);
  }, [useCustomPayout, customPayout, depositWei, payoutPercent]);
  const payoutOk = isValidPayout(depositWei, payoutWei);

  async function refresh(reader = writeClient) {
    if (!contractReady) {
      setRentals([]);
      return;
    }
    const readClient = reader?.readContract ? reader : createReadClient();
    setLoadingList(true);
    setError("");
    try {
      const count = await readRentalCount(readClient);
      const next = [];
      let index = 0n;
      while (index < count) {
        next.push(await readRental(readClient, index.toString()));
        index += 1n;
      }
      setRentals(next.reverse());
    } catch (err) {
      setError(err?.message || "Could not read the contract.");
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    if (!contractReady) return;
    refresh(null);
  }, [contractReady]);

  useEffect(() => {
    if (!window.ethereum) return undefined;
    const onAccounts = (accounts) => setAccount(accounts?.[0] || "");
    window.ethereum.on?.("accountsChanged", onAccounts);
    return () => window.ethereum.removeListener?.("accountsChanged", onAccounts);
  }, []);

  async function connect() {
    setError("");
    try {
      const session = await connectStudionet();
      setAccount(session.address);
      setWriteClient(session);
      setNotice(`Wallet connected on ${CHAIN.name || "studionet"}.`);
      await refresh(session.readClient);
    } catch (err) {
      setError(err?.message || "Could not connect the wallet.");
    }
  }

  async function runTx(key, fn) {
    if (!contractReady) {
      setError("No contract address yet. This page is a preview only.");
      return;
    }
    if (!writeClient) {
      setError("Connect MetaMask on studionet first.");
      return;
    }
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice("Transaction accepted. Refreshing the rental.");
      await refresh(writeClient.readClient);
    } catch (err) {
      setError(err?.message || "Transaction failed.");
    } finally {
      setBusy("");
    }
  }

  async function createRental(event) {
    event.preventDefault();
    if (!payoutOk) {
      setError("The damage payout must be greater than 0 and less than the deposit.");
      return;
    }
    let ownerAddress;
    try {
      ownerAddress = asCalldataAddress(owner.trim());
    } catch (err) {
      setError(err?.message || "The owner address is invalid.");
      return;
    }
    if (sameAddress(owner, account)) {
      setError("The renter and the owner must be two different wallets.");
      return;
    }
    const text = description.trim();
    if (!text) {
      setError("Add a short description of the equipment.");
      return;
    }
    await runTx("create", async () => {
      const before = await readRentalCount(writeClient.readClient);
      await writeAndWait(
        writeClient.writeClient,
        writeClient.readClient,
        "create_rental",
        [ownerAddress, `${category}: ${text}`, payoutWei, deadlineUnix(days)],
        depositWei
      );
      const after = await readRentalCount(writeClient.readClient);
      if (after <= before) {
        throw new Error("The wallet accepted the transaction, but the contract did not save the rental.");
      }
      setNotice(`Created rental #${before.toString()}.`);
      setDescription("");
    });
  }

  function urlsFor(map, id) {
    return map[id]?.length ? map[id] : [""];
  }

  return (
    <div className="page">
      <div className="banner">
        Free to use — you only pay GenLayer network gas when you sign a transaction. There is no other platform fee.
      </div>
      {!contractReady ? (
        <div className="banner warn">
          No contract address yet. Set VITE_CONTRACT_ADDRESS after a successful studionet deploy. This page still opens, and the transaction buttons stay off.
        </div>
      ) : null}

      <header className="top">
        <div>
          <p className="eyebrow">Sharing economy · studionet</p>
          <h1>ToolGuard</h1>
          <p className="lede">
            Peer-to-peer equipment rental escrow. The owner photographs the condition before handover, and the renter photographs it at return. The AI compares the two and chooses only no damage or damaged.
          </p>
        </div>
        <div className="wallet">
          <button type="button" onClick={connect}>
            {account ? "Switch wallet" : "Connect MetaMask"}
          </button>
          <small>{account || "Wallet not connected"}</small>
          <small>{contractReady ? CONTRACT_ADDRESS : "Contract not set"}</small>
        </div>
      </header>

      {error ? <p className="flash bad">{error}</p> : null}
      {notice ? <p className="flash ok">{notice}</p> : null}

      <section className="panel">
        <h2>Create a rental</h2>
        <form onSubmit={createRental}>
          <label>
            Equipment type
            <div className="chips">
              {CATEGORIES.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={item === category ? "chip on" : "chip"}
                  onClick={() => setCategory(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </label>
          <label>
            Short description
            <input
              value={description}
              maxLength={180}
              placeholder="Cordless drill, grey body, 10mm bit"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label>
            Owner address
            <div className="url-row">
              <input value={owner} placeholder="0x..." onChange={(event) => setOwner(event.target.value)} />
              <button
                type="button"
                onClick={async () => setOwner((await navigator.clipboard.readText()).trim())}
              >
                Paste
              </button>
            </div>
          </label>
          <label>
            Deposit (GEN)
            <div className="chips">
              {DEPOSIT_CHIPS.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={depositText === item ? "chip on" : "chip"}
                  onClick={() => setDepositText(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            <input value={depositText} inputMode="decimal" onChange={(event) => setDepositText(event.target.value)} />
          </label>
          <label>
            Damage payout
            <div className="chips">
              {PAYOUT_PERCENTS.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={!useCustomPayout && payoutPercent === item ? "chip on" : "chip"}
                  onClick={() => {
                    setUseCustomPayout(false);
                    setPayoutPercent(item);
                  }}
                >
                  {item}% of deposit
                </button>
              ))}
              <button
                type="button"
                className={useCustomPayout ? "chip on" : "chip"}
                onClick={() => setUseCustomPayout(true)}
              >
                Custom amount
              </button>
            </div>
            {useCustomPayout ? (
              <input
                value={customPayout}
                inputMode="decimal"
                placeholder="GEN"
                onChange={(event) => setCustomPayout(event.target.value)}
              />
            ) : null}
          </label>
          <label>
            Return deadline
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              {DEADLINES.map((item) => (
                <option key={item.days} value={item.days}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <p className="preview">
            Deposit {formatWeiToGen(depositWei)} GEN. If damaged, the owner receives {formatWeiToGen(payoutWei)} GEN and the renter receives{" "}
            {formatWeiToGen(subtractWei(depositWei, payoutWei))} GEN back. If undamaged, the renter receives the full deposit back.
          </p>
          <button type="submit" disabled={!contractReady || !payoutOk || busy === "create"}>
            {busy === "create" ? "Sending deposit..." : "Send deposit and create rental"}
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="row">
          <h2>Rentals</h2>
          <button type="button" className="ghost" onClick={() => refresh(writeClient?.readClient)} disabled={!contractReady || loadingList}>
            {loadingList ? "Loading..." : "Refresh"}
          </button>
        </div>
        {!contractReady ? <p>The list appears after a contract address is set.</p> : null}
        {contractReady && rentals.length === 0 && !loadingList ? <p>No rentals on this contract yet.</p> : null}
        {rentals.map((rental) => {
          const id = String(rental.id);
          const mineOwner = sameAddress(account, rental.owner);
          const mineRenter = sameAddress(account, rental.renter);
          const deadline = BigInt(String(rental.rental_end_deadline || "0"));
          const now = BigInt(Date.now()) / 1000n;
          const overdue = now > deadline && rental.status === "RENTED";
          return (
            <article className="card" key={id}>
              <header>
                <strong>Rental #{id}</strong>
                <span>{STATUS_LABEL[rental.status] || rental.status}</span>
              </header>
              <p>{rental.equipment_description}</p>
              <p className="meta">
                Owner {rental.owner}
                <br />
                Renter {rental.renter}
              </p>
              <p>{settlementText(rental)}</p>
              {rental.verdict ? (
                <p className="verdict">
                  {rental.verdict} · confidence {rental.confidence}/100
                  <br />
                  {rental.verdict_reason}
                </p>
              ) : null}
              {rental.status === "PAYOUT_FAILED" || rental.owner_paid || rental.renter_refunded ? (
                <ul className="flags">
                  <li>Owner paid: {rental.owner_paid ? "yes" : "no"}</li>
                  <li>Renter refunded: {rental.renter_refunded ? "yes" : "no"}</li>
                </ul>
              ) : null}
              <p className="hint">
                The owner should photograph BEFORE handover, and the renter should photograph AT THE MOMENT of return. Clearer angles make the AI comparison easier.
              </p>

              {rental.status === "AWAITING_HANDOVER" && mineOwner ? (
                <div>
                  <UrlEditor
                    label="Photos or links of the condition before handover"
                    urls={urlsFor(preUrls, id)}
                    onChange={(next) => setPreUrls({ ...preUrls, [id]: next })}
                  />
                  <button
                    type="button"
                    disabled={busy === `hand-${id}`}
                    onClick={() =>
                      runTx(`hand-${id}`, () =>
                        writeAndWait(writeClient.writeClient, writeClient.readClient, "submit_handover_condition", [
                          id,
                          urlsFor(preUrls, id).map((item) => item.trim()).filter(Boolean),
                        ])
                      )
                    }
                  >
                    {busy === `hand-${id}` ? "Sending..." : "Confirm handover"}
                  </button>
                </div>
              ) : null}

              {(rental.status === "RENTED" || rental.status === "DISPUTED") && mineRenter ? (
                <div>
                  <UrlEditor
                    label="Photos or links of the condition at return"
                    urls={urlsFor(postUrls, id)}
                    onChange={(next) => setPostUrls({ ...postUrls, [id]: next })}
                  />
                  <UrlEditor
                    label="Extra sources, optional"
                    urls={urlsFor(refUrls, id)}
                    onChange={(next) => setRefUrls({ ...refUrls, [id]: next })}
                  />
                  <button
                    type="button"
                    disabled={busy === `ret-${id}`}
                    onClick={() =>
                      runTx(`ret-${id}`, () =>
                        writeAndWait(writeClient.writeClient, writeClient.readClient, "report_return", [
                          id,
                          urlsFor(postUrls, id).map((item) => item.trim()).filter(Boolean),
                          urlsFor(refUrls, id).map((item) => item.trim()).filter(Boolean),
                        ])
                      )
                    }
                  >
                    {busy === `ret-${id}` ? "Sending..." : rental.status === "DISPUTED" ? "Resubmit evidence" : "Report return"}
                  </button>
                </div>
              ) : null}

              {rental.status === "RETURN_REPORTED" ? (
                <button
                  type="button"
                  disabled={!contractReady || busy === `ai-${id}`}
                  onClick={() =>
                    runTx(`ai-${id}`, () =>
                      writeAndWait(writeClient.writeClient, writeClient.readClient, "resolve_rental", [id])
                    )
                  }
                >
                  {busy === `ai-${id}` ? "The AI is comparing the before and after photos..." : "Ask the AI to decide"}
                </button>
              ) : null}

              {overdue && mineOwner ? (
                <button
                  type="button"
                  disabled={busy === `forfeit-${id}`}
                  onClick={() =>
                    runTx(`forfeit-${id}`, () =>
                      writeAndWait(writeClient.writeClient, writeClient.readClient, "claim_no_return_forfeit", [id])
                    )
                  }
                >
                  {busy === `forfeit-${id}` ? "Claiming deposit..." : "Overdue — claim the full deposit"}
                </button>
              ) : null}

              {rental.status === "PAYOUT_FAILED" && (mineOwner || mineRenter) ? (
                <button
                  type="button"
                  disabled={busy === `retry-${id}`}
                  onClick={() =>
                    runTx(`retry-${id}`, () =>
                      writeAndWait(writeClient.writeClient, writeClient.readClient, "retry_resolution", [id])
                    )
                  }
                >
                  {busy === `retry-${id}` ? "Retrying..." : "Retry the unpaid side"}
                </button>
              ) : null}
            </article>
          );
        })}
      </section>
    </div>
  );
}
