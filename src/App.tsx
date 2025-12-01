import { useMemo } from "react";
import {
  isHex,
  type Hex,
  type Address,
  createPublicClient,
  http,
  decodeFunctionData,
  type Abi,
  type AbiFunction,
  type AbiParameter,
} from "viem";
import { entryPoint06Abi, entryPoint06Address } from "viem/account-abstraction";
import { useReadContract } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { useQueryState, parseAsInteger, parseAsStringLiteral } from "nuqs";
import { whatsabi } from "@shazow/whatsabi";
import { supportedChains } from "./wagmi";

type EntryPointVersion = "0.6";

interface UserOpV06 {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: Hex;
  signature: Hex;
}

type InputMode = "raw" | "fields";

// Helper functions for calldata decoding
function formatArg(arg: unknown): string {
  if (typeof arg === "bigint") {
    return arg.toString();
  }
  if (typeof arg === "object" && arg !== null) {
    if (Array.isArray(arg)) {
      return `[${arg.map(formatArg).join(", ")}]`;
    }
    return JSON.stringify(
      arg,
      (_, value) => (typeof value === "bigint" ? value.toString() : value),
      2
    );
  }
  return String(arg);
}

// Format ABI type for display
function formatAbiType(param: AbiParameter): string {
  if (param.type === "tuple" && "components" in param && param.components) {
    const components = param.components
      .map((c) => `${formatAbiType(c)} ${c.name || ""}`.trim())
      .join(", ");
    return `(${components})`;
  }
  if (param.type === "tuple[]" && "components" in param && param.components) {
    const components = param.components
      .map((c) => `${formatAbiType(c)} ${c.name || ""}`.trim())
      .join(", ");
    return `(${components})[]`;
  }
  return param.type;
}

interface DecodedCallWithTypes {
  functionName: string;
  args?: readonly unknown[];
  inputs?: readonly AbiParameter[];
}

interface ArgWithDecodedCall {
  target?: string;
  to?: string;
  decodedCall?: DecodedCallWithTypes;
  [key: string]: unknown;
}

interface ArgRendererProps {
  value: unknown;
  type?: AbiParameter;
}

function ArgRenderer({ value, type }: ArgRendererProps) {
  if (value === null) return <span className="muted">null</span>;

  if (Array.isArray(value)) {
    // For arrays, try to get the component type
    const componentType =
      type && "components" in type ? type.components : undefined;
    const itemType =
      type && componentType
        ? ({
            ...type,
            type: type.type.replace("[]", ""),
            components: componentType,
          } as AbiParameter)
        : undefined;
    return (
      <div className="arg-array">
        {value.map((item, i) => (
          <div key={i} className="arg-item">
            <ArgRenderer value={item} type={itemType} />
            {i < value.length - 1 && <span className="muted">,</span>}
          </div>
        ))}
      </div>
    );
  }

  if (typeof value === "object") {
    const objValue = value as ArgWithDecodedCall;
    if (objValue.decodedCall) {
      return (
        <div className="decoded-call">
          <div className="decoded-call-header">
            <span className="muted">Action: </span>
            <span className="fn-name">{objValue.decodedCall.functionName}</span>
          </div>
          <div className="decoded-call-args">
            {objValue.decodedCall.args?.map((arg, i) => {
              const argType = objValue.decodedCall?.inputs?.[i];
              return (
                <div key={i} className="arg-row">
                  <span className="arg-name">
                    {argType?.name || `arg[${i}]`}
                  </span>
                  {argType && (
                    <span className="arg-type">{formatAbiType(argType)}</span>
                  )}
                  <ArgRenderer value={arg} type={argType} />
                </div>
              );
            })}
          </div>
          <div className="decoded-call-target">
            Target: {objValue.target || objValue.to}
          </div>
        </div>
      );
    }

    return <span className="arg-value">{formatArg(value)}</span>;
  }

  return <span className="arg-value">{formatArg(value)}</span>;
}

function parseValue(value: string): bigint {
  const trimmed = value.trim();
  if (!trimmed) return 0n;

  if (isHex(trimmed)) {
    return BigInt(trimmed);
  }

  if (trimmed.endsWith("n")) {
    return BigInt(trimmed.slice(0, -1));
  }

  return BigInt(trimmed);
}

function parseHexValue(value: string): Hex {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "0x") return "0x";
  if (isHex(trimmed)) return trimmed;
  throw new Error(`Invalid hex value: ${value}`);
}

function parseUserOpFromRaw(raw: string): UserOpV06 | null {
  try {
    const parsed = JSON.parse(raw);
    return {
      sender: parsed.sender as Address,
      nonce: parseValue(String(parsed.nonce)),
      initCode: parseHexValue(parsed.initCode),
      callData: parseHexValue(parsed.callData),
      callGasLimit: parseValue(String(parsed.callGasLimit)),
      verificationGasLimit: parseValue(String(parsed.verificationGasLimit)),
      preVerificationGas: parseValue(String(parsed.preVerificationGas)),
      maxFeePerGas: parseValue(String(parsed.maxFeePerGas)),
      maxPriorityFeePerGas: parseValue(String(parsed.maxPriorityFeePerGas)),
      paymasterAndData: parseHexValue(parsed.paymasterAndData),
      signature: parseHexValue(parsed.signature),
    };
  } catch {
    return null;
  }
}

const inputModeParser = parseAsStringLiteral(["raw", "fields"] as const);

function App() {
  const [chainId, setChainId] = useQueryState(
    "chain",
    parseAsInteger.withDefault(1)
  );
  const [, setEntryPointVersion] = useQueryState<EntryPointVersion>("ep", {
    defaultValue: "0.6",
    parse: (v) => v as EntryPointVersion,
    serialize: (v) => v,
  });
  const entryPointVersion: EntryPointVersion = "0.6";
  const [inputMode, setInputMode] = useQueryState(
    "mode",
    inputModeParser.withDefault("raw")
  );
  const [rawInput, setRawInput] = useQueryState("raw", { defaultValue: "" });
  const [expectedHash, setExpectedHash] = useQueryState("hash", {
    defaultValue: "",
  });

  // Field inputs
  const [sender, setSender] = useQueryState("sender", { defaultValue: "" });
  const [nonce, setNonce] = useQueryState("nonce", { defaultValue: "" });
  const [initCode, setInitCode] = useQueryState("initCode", {
    defaultValue: "0x",
  });
  const [callData, setCallData] = useQueryState("callData", {
    defaultValue: "0x",
  });
  const [callGasLimit, setCallGasLimit] = useQueryState("callGasLimit", {
    defaultValue: "",
  });
  const [verificationGasLimit, setVerificationGasLimit] = useQueryState(
    "verificationGasLimit",
    { defaultValue: "" }
  );
  const [preVerificationGas, setPreVerificationGas] = useQueryState(
    "preVerificationGas",
    { defaultValue: "" }
  );
  const [maxFeePerGas, setMaxFeePerGas] = useQueryState("maxFeePerGas", {
    defaultValue: "",
  });
  const [maxPriorityFeePerGas, setMaxPriorityFeePerGas] = useQueryState(
    "maxPriorityFeePerGas",
    { defaultValue: "" }
  );
  const [paymasterAndData, setPaymasterAndData] = useQueryState(
    "paymasterAndData",
    { defaultValue: "0x" }
  );
  const [signature, setSignature] = useQueryState("signature", {
    defaultValue: "0x",
  });

  void setEntryPointVersion;

  const parsedUserOp = useMemo<UserOpV06 | null>(() => {
    if (inputMode === "raw") {
      return parseUserOpFromRaw(rawInput);
    }

    try {
      return {
        sender: sender as Address,
        nonce: parseValue(nonce),
        initCode: parseHexValue(initCode),
        callData: parseHexValue(callData),
        callGasLimit: parseValue(callGasLimit),
        verificationGasLimit: parseValue(verificationGasLimit),
        preVerificationGas: parseValue(preVerificationGas),
        maxFeePerGas: parseValue(maxFeePerGas),
        maxPriorityFeePerGas: parseValue(maxPriorityFeePerGas),
        paymasterAndData: parseHexValue(paymasterAndData),
        signature: parseHexValue(signature),
      };
    } catch {
      return null;
    }
  }, [
    inputMode,
    rawInput,
    sender,
    nonce,
    initCode,
    callData,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    paymasterAndData,
    signature,
  ]);

  const selectedChain = supportedChains.find((c) => c.id === chainId);

  // Create public client for whatsabi
  const client = useMemo(() => {
    if (!selectedChain) return null;
    return createPublicClient({
      chain: selectedChain,
      transport: http(),
    });
  }, [selectedChain]);

  // Decode callData using whatsabi
  const { data: decodedCallData, isLoading: isDecodingCallData } = useQuery({
    queryKey: [
      "decodeCallData",
      parsedUserOp?.sender,
      parsedUserOp?.callData,
      chainId,
    ],
    queryFn: async () => {
      if (
        !parsedUserOp?.sender ||
        !parsedUserOp?.callData ||
        parsedUserOp.callData === "0x" ||
        !client
      ) {
        return null;
      }

      try {
        const result = await whatsabi.autoload(parsedUserOp.sender, {
          provider: client,
          ...whatsabi.loaders.defaultsWithEnv({
            ETHERSCAN_API_KEY: import.meta.env.VITE_ETHERSCAN_API_KEY,
            CHAIN_ID: chainId,
          }),
          followProxies: true,
        });

        if (!result.abi) return null;

        const decoded = decodeFunctionData({
          abi: result.abi as Abi,
          data: parsedUserOp.callData,
        });

        // Find the function in the ABI to get input types
        const abiFunction = (result.abi as Abi).find(
          (item): item is AbiFunction =>
            item.type === "function" && item.name === decoded.functionName
        );
        const inputs = abiFunction?.inputs;

        // Recursively enrich args with decoded inner calls
        const enrichArgs = async (
          args: readonly unknown[]
        ): Promise<unknown[]> => {
          return Promise.all(
            args.map(async (arg) => {
              if (Array.isArray(arg)) {
                return enrichArgs(arg);
              }
              if (arg && typeof arg === "object") {
                const objArg = arg as Record<string, unknown>;
                const target = (objArg.target || objArg.to) as
                  | string
                  | undefined;
                const data = (objArg.callData || objArg.data) as
                  | Hex
                  | undefined;

                if (target && data && isHex(data) && data !== "0x") {
                  try {
                    const r = await whatsabi.autoload(target, {
                      provider: client,
                    });
                    if (r.abi) {
                      const decodedInner = decodeFunctionData({
                        abi: r.abi as Abi,
                        data,
                      });
                      // Find inner function inputs
                      const innerAbiFunction = (r.abi as Abi).find(
                        (item): item is AbiFunction =>
                          item.type === "function" &&
                          item.name === decodedInner.functionName
                      );
                      return {
                        ...objArg,
                        decodedCall: {
                          ...decodedInner,
                          inputs: innerAbiFunction?.inputs,
                        },
                      };
                    }
                  } catch (e) {
                    console.log("Inner decode failed", e);
                  }
                }
              }
              return arg;
            })
          );
        };

        if (decoded.args) {
          const args = await enrichArgs(decoded.args);
          return { ...decoded, args, inputs };
        }

        return { ...decoded, inputs };
      } catch (e) {
        console.error("WhatsABI decode error:", e);
        return null;
      }
    },
    enabled:
      !!parsedUserOp?.sender &&
      !!parsedUserOp?.callData &&
      parsedUserOp.callData !== "0x" &&
      !!client,
    retry: false,
  });

  // Simulate the UserOp using eth_simulateV1
  const {
    data: simulationResult,
    isLoading: isSimulating,
    error: simulationError,
  } = useQuery({
    queryKey: [
      "simulateUserOp",
      parsedUserOp?.sender,
      parsedUserOp?.callData,
      chainId,
    ],
    queryFn: async () => {
      if (
        !parsedUserOp?.sender ||
        !parsedUserOp?.callData ||
        parsedUserOp.callData === "0x" ||
        !client
      ) {
        return null;
      }

      try {
        const result = await client.simulateCalls({
          account: parsedUserOp.sender,
          calls: [
            {
              to: parsedUserOp.sender,
              data: parsedUserOp.callData,
            },
          ],
          stateOverrides: [
            {
              // Override sender balance to ensure it has enough for gas
              address: parsedUserOp.sender,
              balance: BigInt("0xffffffffffffffffffff"),
            },
          ],
        });
        return result;
      } catch (e) {
        // eth_simulateV1 might not be supported
        console.error("Simulation error:", e);
        throw e;
      }
    },
    enabled:
      !!parsedUserOp?.sender &&
      !!parsedUserOp?.callData &&
      parsedUserOp.callData !== "0x" &&
      !!client,
    retry: false,
  });

  const {
    data: computedHash,
    isLoading,
    error,
  } = useReadContract({
    address: entryPoint06Address,
    abi: entryPoint06Abi,
    functionName: "getUserOpHash",
    args: parsedUserOp ? [parsedUserOp] : undefined,
    chainId,
    query: {
      enabled: !!parsedUserOp,
    },
  });

  const normalizedExpectedHash = expectedHash.trim().toLowerCase();
  const normalizedComputedHash = computedHash?.toLowerCase();
  const hashesMatch =
    normalizedExpectedHash &&
    normalizedComputedHash &&
    normalizedExpectedHash === normalizedComputedHash;

  return (
    <div className="container">
      <header className="header">
        <h1>UserOp Hash Verifier</h1>
        <div className="header-links">
          <a
            href="https://eips.ethereum.org/EIPS/eip-4337"
            target="_blank"
            rel="noopener noreferrer"
            className="link"
          >
            ERC-4337
          </a>
          <a
            href="https://github.com/stephancill/4337-userop-validator"
            target="_blank"
            rel="noopener noreferrer"
            className="link"
          >
            GitHub
          </a>
        </div>
      </header>

      <div className="section">
        <label>
          Chain
          <select
            value={chainId}
            onChange={(e) => setChainId(Number(e.target.value))}
          >
            {supportedChains.map((chain) => (
              <option key={chain.id} value={chain.id}>
                {chain.name} ({chain.id})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="section">
        <label>
          EntryPoint Version
          <select value={entryPointVersion} disabled>
            <option value="0.6">v0.6</option>
          </select>
        </label>
        <div className="hint">
          EntryPoint: <code>{entryPoint06Address}</code>
        </div>
      </div>

      <div className="section">
        <label>
          Input Mode
          <select
            value={inputMode}
            onChange={(e) => setInputMode(e.target.value as InputMode)}
          >
            <option value="raw">Raw JSON</option>
            <option value="fields">Individual Fields</option>
          </select>
        </label>
      </div>

      {inputMode === "raw" ? (
        <div className="section">
          <label>
            UserOperation JSON
            <textarea
              value={rawInput}
              onChange={(e) => setRawInput(e.target.value)}
              placeholder='{"sender": "0x...", "nonce": "0", ...}'
              rows={12}
            />
          </label>
        </div>
      ) : (
        <div className="section fields-grid">
          <label>
            sender
            <input
              value={sender}
              onChange={(e) => setSender(e.target.value)}
              placeholder="0x..."
            />
          </label>
          <label>
            nonce
            <input
              value={nonce}
              onChange={(e) => setNonce(e.target.value)}
              placeholder="0"
            />
          </label>
          <label>
            initCode
            <input
              value={initCode}
              onChange={(e) => setInitCode(e.target.value)}
              placeholder="0x"
            />
          </label>
          <label>
            callData
            <textarea
              value={callData}
              onChange={(e) => setCallData(e.target.value)}
              placeholder="0x"
              rows={3}
            />
          </label>
          <label>
            callGasLimit
            <input
              value={callGasLimit}
              onChange={(e) => setCallGasLimit(e.target.value)}
              placeholder="0"
            />
          </label>
          <label>
            verificationGasLimit
            <input
              value={verificationGasLimit}
              onChange={(e) => setVerificationGasLimit(e.target.value)}
              placeholder="0"
            />
          </label>
          <label>
            preVerificationGas
            <input
              value={preVerificationGas}
              onChange={(e) => setPreVerificationGas(e.target.value)}
              placeholder="0"
            />
          </label>
          <label>
            maxFeePerGas
            <input
              value={maxFeePerGas}
              onChange={(e) => setMaxFeePerGas(e.target.value)}
              placeholder="0"
            />
          </label>
          <label>
            maxPriorityFeePerGas
            <input
              value={maxPriorityFeePerGas}
              onChange={(e) => setMaxPriorityFeePerGas(e.target.value)}
              placeholder="0"
            />
          </label>
          <label>
            paymasterAndData
            <textarea
              value={paymasterAndData}
              onChange={(e) => setPaymasterAndData(e.target.value)}
              placeholder="0x"
              rows={2}
            />
          </label>
          <label>
            signature
            <textarea
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder="0x"
              rows={3}
            />
          </label>
        </div>
      )}

      <div className="section">
        <label>
          Expected Hash (optional)
          <input
            value={expectedHash}
            onChange={(e) => setExpectedHash(e.target.value)}
            placeholder="0x..."
          />
        </label>
      </div>

      <hr />

      <div className="section">
        <h2>Parsed UserOperation</h2>
        {parsedUserOp ? (
          <pre>
            {JSON.stringify(
              {
                ...parsedUserOp,
                nonce: parsedUserOp.nonce.toString(),
                callGasLimit: parsedUserOp.callGasLimit.toString(),
                verificationGasLimit:
                  parsedUserOp.verificationGasLimit.toString(),
                preVerificationGas: parsedUserOp.preVerificationGas.toString(),
                maxFeePerGas: parsedUserOp.maxFeePerGas.toString(),
                maxPriorityFeePerGas:
                  parsedUserOp.maxPriorityFeePerGas.toString(),
              },
              null,
              2
            )}
          </pre>
        ) : (
          <div className="error">Invalid or empty UserOperation</div>
        )}
      </div>

      {/* Decoded CallData Section */}
      {parsedUserOp?.callData && parsedUserOp.callData !== "0x" && (
        <div className="section">
          <h2>Decoded CallData</h2>
          {isDecodingCallData ? (
            <div className="muted">Decoding...</div>
          ) : decodedCallData ? (
            <div className="decoded-section">
              <div className="decoded-header">
                <span className="fn-name">{decodedCallData.functionName}</span>
              </div>
              {decodedCallData.args && decodedCallData.args.length > 0 && (
                <div className="decoded-args">
                  {decodedCallData.args.map((arg, i) => {
                    const argType = decodedCallData.inputs?.[i];
                    return (
                      <div key={i} className="arg-row">
                        <span className="arg-name">
                          {argType?.name || `arg[${i}]`}
                        </span>
                        {argType && (
                          <span className="arg-type">
                            {formatAbiType(argType)}
                          </span>
                        )}
                        <ArgRenderer value={arg} type={argType} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="muted">Could not decode callData</div>
          )}
        </div>
      )}

      {/* Simulation Results Section */}
      {parsedUserOp?.callData && parsedUserOp.callData !== "0x" && (
        <div className="section">
          <h2>Simulation (eth_simulateV1)</h2>
          {isSimulating ? (
            <div className="muted">Simulating...</div>
          ) : simulationError ? (
            <div className="simulation-error">
              <div className="error-label">Simulation failed</div>
              <div className="error-message">
                {simulationError instanceof Error
                  ? simulationError.message.includes("not supported") ||
                    simulationError.message.includes("Method not found")
                    ? "eth_simulateV1 is not supported on this RPC"
                    : simulationError.message
                  : "Unknown error"}
              </div>
            </div>
          ) : simulationResult?.results?.[0] ? (
            <div className="simulation-result">
              <div className="simulation-status">
                <span
                  className={`status-badge ${simulationResult.results[0].status}`}
                >
                  {simulationResult.results[0].status === "success"
                    ? "✓ Success"
                    : "✗ Reverted"}
                </span>
              </div>
              <div className="simulation-details">
                <div className="detail-row">
                  <span className="detail-label">Gas Used</span>
                  <span className="detail-value">
                    {simulationResult.results[0].gasUsed?.toString() ?? "N/A"}
                  </span>
                </div>
                {simulationResult.results[0].status === "failure" &&
                  "error" in simulationResult.results[0] && (
                    <div className="detail-row error">
                      <span className="detail-label">Error</span>
                      <span className="detail-value">
                        {(simulationResult.results[0].error as Error)
                          ?.message ?? "Execution reverted"}
                      </span>
                    </div>
                  )}
                {"result" in simulationResult.results[0] &&
                  simulationResult.results[0].result !== undefined && (
                    <div className="detail-row">
                      <span className="detail-label">Return Value</span>
                      <span className="detail-value arg-value">
                        {formatArg(simulationResult.results[0].result)}
                      </span>
                    </div>
                  )}
                {simulationResult.results[0].logs &&
                  simulationResult.results[0].logs.length > 0 && (
                    <div className="detail-row">
                      <span className="detail-label">
                        Logs ({simulationResult.results[0].logs.length})
                      </span>
                      <div className="logs-list">
                        {simulationResult.results[0].logs.map((log, i) => (
                          <div key={i} className="log-entry">
                            <div className="log-address">{log.address}</div>
                            <div className="log-topics">
                              {log.topics.map((topic, j) => (
                                <div key={j} className="log-topic">
                                  topic[{j}]: {topic}
                                </div>
                              ))}
                            </div>
                            {log.data && log.data !== "0x" && (
                              <div className="log-data">data: {log.data}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            </div>
          ) : (
            <div className="muted">No simulation result</div>
          )}
        </div>
      )}

      <div className="section">
        <h2>Computed Hash</h2>
        {isLoading && <div>Loading...</div>}
        {error && <div className="error">Error: {error.message}</div>}
        {computedHash && (
          <div>
            <code className="hash">{computedHash}</code>
            <div className="hint">
              Chain: {selectedChain?.name} ({chainId})
            </div>
          </div>
        )}
      </div>

      {normalizedExpectedHash && computedHash && (
        <div className="section">
          <h2>Hash Comparison</h2>
          <div className={hashesMatch ? "match success" : "match error"}>
            {hashesMatch ? "✓ Hashes match!" : "✗ Hashes do not match"}
          </div>
          {!hashesMatch && (
            <div className="comparison">
              <div>
                <strong>Expected:</strong>
                <code>{normalizedExpectedHash}</code>
              </div>
              <div>
                <strong>Computed:</strong>
                <code>{normalizedComputedHash}</code>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
