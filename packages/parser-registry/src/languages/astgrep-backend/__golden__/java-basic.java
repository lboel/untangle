package com.example.ledger;

import java.util.List;
import java.util.Map;
import static java.util.Collections.emptyList;

/** A ledger of entries. */
public class Ledger implements AutoCloseable {
    private final Map<String, Long> balances;
    public static final int MAX = 100;

    public Ledger(Map<String, Long> balances) {
        this.balances = balances;
    }

    /** Applies one entry. */
    public long apply(String account, long amount) throws IllegalStateException {
        if (account == null || account.isEmpty()) {
            throw new IllegalStateException("account");
        } else if (amount == 0) {
            return 0;
        }
        long current = balances.getOrDefault(account, 0L);
        long next = current + amount;
        try {
            for (int i = 0; i < MAX && next > 0; i++) {
                next -= 1;
            }
            while (next < 0) { next++; }
            switch (account) {
                case "a":
                    next = 1;
                    break;
                case "b":
                case "c":
                    next = 2;
                    break;
                default:
                    break;
            }
        } catch (RuntimeException e) {
            next = current;
        } finally {
            balances.put(account, next);
        }
        return next > 0 ? next : 0;
    }

    interface Visitor {
        void visit(String key);
    }

    enum Kind { DEBIT, CREDIT }

    record Entry(String account, long amount) {}

    @Override
    public void close() {
        List<String> keys = emptyList();
        keys.forEach(k -> balances.remove(k));
    }
}
