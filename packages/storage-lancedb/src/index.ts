/** Real persistent local LanceDB adapter. Native SDK loading is access-lazy. */
export * from "./factory.js";
export * from "./vector-store.js";

// Use exactly the same identifier tokenizer/hash space as indexing and Qdrant.
export {
  textToBm25SparseVector,
  tokenizeForBm25,
  hashBm25Token,
} from "@untangle-code/storage-qdrant";
