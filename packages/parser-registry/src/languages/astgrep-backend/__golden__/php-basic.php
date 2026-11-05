<?php

namespace App\Billing;

use App\Money;
use App\Contracts\Payable as PayableContract;

const TAX = 0.19;

interface Payable
{
    public function total(): float;
}

trait HasLines
{
    public function lineCount(): int
    {
        return count($this->lines);
    }
}

/** An invoice. */
class Invoice implements Payable
{
    use HasLines;

    private array $lines = [];
    public const CURRENCY = 'EUR';

    public function __construct(array $lines)
    {
        $this->lines = $lines;
    }

    /** Sums all lines. */
    public function total(): float
    {
        if (empty($this->lines)) {
            return 0.0;
        } elseif (count($this->lines) > 100) {
            throw new \RuntimeException('too many');
        }

        $sum = 0.0;
        foreach ($this->lines as $line) {
            if ($line['amount'] > 0 && !$line['void'] || $line['forced']) {
                $sum += $line['amount'];
            }
        }
        for ($i = 0; $i < 3; $i++) {
            while ($sum < 0) { $sum++; }
        }
        try {
            switch (self::CURRENCY) {
                case 'EUR':
                    $sum *= (1 + TAX);
                    break;
                default:
                    break;
            }
        } catch (\Throwable $e) {
            $sum = 0.0;
        }
        return $sum > 0 ? $sum : 0.0;
    }
}

function makeInvoice(array $lines): Invoice
{
    return new Invoice($lines);
}
