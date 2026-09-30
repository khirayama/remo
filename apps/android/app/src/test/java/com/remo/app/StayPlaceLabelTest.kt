package com.remo.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StayPlaceLabelTest {
    @Test
    fun displayAddressDropsCountryPostalCodeAndPrefecture() {
        assertEquals(
            "福岡市中央区桜坂1丁目15-13 東急ドエルアルス桜坂",
            displayAddress("日本、〒810-0024 福岡県福岡市中央区桜坂１丁目１５-１３ 東急ドエルアルス桜坂", "日本", "福岡県"),
        )
    }

    @Test
    fun displayAddressKeepsLinesWithoutKnownPrefixes() {
        assertEquals("1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA", displayAddress("1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA", "United States", "California"))
        assertEquals(null, displayAddress("  ", null))
    }

    @Test
    fun houseNumbersAreNotPlaceNames() {
        assertTrue(isHouseNumber("13"))
        assertTrue(isHouseNumber("１５−１３"))
        assertTrue(isHouseNumber("3丁目"))
        assertFalse(isHouseNumber("双葉荘"))
        assertFalse(isHouseNumber("桜坂1丁目"))
    }
}
