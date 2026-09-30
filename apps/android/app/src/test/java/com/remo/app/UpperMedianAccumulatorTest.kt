package com.remo.app

import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.random.Random

class UpperMedianAccumulatorTest {
    @Test fun incrementalMedianMatchesPreviousSortForEveryPrefixIncludingDuplicates() {
        val accumulator = UpperMedianAccumulator()
        val values = mutableListOf<Double>()
        val random = Random(17)
        repeat(1_000) {
            val value = 35.0 + random.nextInt(-50, 51) * 0.00001
            values += value
            accumulator.add(value)
            assertEquals(values.sorted()[values.size / 2], accumulator.median(), 0.0)
        }
    }
}
