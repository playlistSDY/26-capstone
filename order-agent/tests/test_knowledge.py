import unittest

from switch_agent.domain import OrderStore
from switch_agent.knowledge import database, details, suitable


class KnowledgeTest(unittest.TestCase):
    def test_all_demo_products_have_populated_variant_information(self):
        store = OrderStore.demo()
        knowledge = database()["items"]
        self.assertEqual(set(knowledge), set(store.catalog))
        for pid, product in store.catalog.items():
            item = knowledge[pid]
            self.assertTrue(item["ingredients"])
            self.assertTrue(item["summary"])
            self.assertEqual({v["temperature"] for v in item["variants"]}, set(product["temperatures"]))
            for ingredient in item["ingredients"]:
                self.assertIsInstance(ingredient["amount_demo"], (float, int))
                self.assertEqual(ingredient["amount_origin"], "demo_estimate")
            for variant in item["variants"]:
                self.assertEqual(set(variant["values"]), set(variant["value_origins"]))
                self.assertTrue(variant["allergen_note"])
                self.assertTrue(variant["source_url"].startswith("https://ediya.com/"))
                for key, value in variant["values"].items():
                    self.assertIsInstance(value, (float, int))
                    self.assertGreaterEqual(value, 0)
                    self.assertIn(variant["value_origins"][key], {"official", "demo_estimate"})

    def test_each_menu_has_complete_scoped_store_profile(self):
        for pid in OrderStore.demo().catalog:
            profile = details(pid)["store_profile"]
            self.assertEqual(profile["scope"], "fictional_demo_store_only")
            self.assertTrue(profile["recipe"])
            self.assertTrue(profile["variants"])
            self.assertTrue(profile["preparation"]["less_sweet"])
            self.assertTrue(profile["allergy_handling"]["guarantee_statement"])
            for ingredient in profile["recipe"]:
                self.assertTrue(ingredient["ingredient"])
                self.assertIsInstance(ingredient["amount"], (int, float))
                self.assertTrue(ingredient["unit"])

    def test_store_profile_keeps_reference_provenance_separate(self):
        menu = details("drink-93a6ef6430f6", "ice")
        self.assertEqual(menu["store_profile"]["variants"][0]["nutrition"], menu["variants"][0]["values"])
        self.assertTrue(all(v == "demo_estimate" for v in menu["variants"][0]["value_origins"].values()))

    def test_store_policy_does_not_guarantee_allergy_safety(self):
        profile = details("latte", "ice")["store_profile"]
        self.assertTrue(profile["allergy_handling"]["shared_equipment"])
        self.assertIn("차단", profile["allergy_handling"]["guarantee_statement"])
        self.assertIn("제거되지", profile["preparation"]["oat_milk"])

    def test_decaf_is_not_reported_as_caffeine_free(self):
        decaf = details("americano-decaf", "ice", decaf=True)["variants"][0]
        self.assertGreater(decaf["values"]["caffeine_mg"], 0)
        self.assertFalse(suitable(decaf, "none", "any", []))

    def test_hot_and_ice_sugar_values_remain_separate(self):
        iced = details("chocolate", "ice")["variants"][0]
        hot = details("chocolate", "hot")["variants"][0]
        self.assertNotEqual(iced["values"]["sugar_g"], hot["values"]["sugar_g"])

    def test_milk_allergy_filter_excludes_latte_and_chocolate(self):
        for pid in ["latte", "chocolate"]:
            self.assertFalse(suitable(details(pid, "ice")["variants"][0], "any", "any", ["유제품"]))

    def test_caffeine_free_low_sugar_candidates_meet_both_conditions(self):
        for item in database()["items"].values():
            for v in item["variants"]:
                if suitable(v, "none", "less", []):
                    self.assertEqual(v["values"]["caffeine_mg"], 0)
                    self.assertLessEqual(v["values"]["sugar_g"], 15)

    def test_unmatched_water_values_are_explicit_estimates(self):
        v = details("drink-93a6ef6430f6", "ice")["variants"][0]
        self.assertTrue(all(origin == "demo_estimate" for origin in v["value_origins"].values()))
        self.assertEqual(v["official_id"], "not_matched")

    def test_zero_sugar_sweet_drink_is_not_recommended_as_unsweetened(self):
        v = details("drink-386592639b03", "ice")["variants"][0]
        self.assertEqual(v["values"]["sugar_g"], 0)
        self.assertEqual(v["sweetness"], "달아요")
        self.assertFalse(suitable(v, "any", "less", []))

    def test_nonstandard_allergy_excludes_ingredient_even_without_listed_allergens(self):
        chamomile = details("chamomile", "hot")["variants"][0]
        self.assertEqual(chamomile["allergens"], [])
        self.assertFalse(suitable(chamomile, "none", "any", ["캐모마일"]))
        self.assertFalse(suitable(chamomile, "none", "any", ["카모마일"]))
        self.assertFalse(suitable(chamomile, "none", "any", ["Chamomile"]))

    def test_excluded_ingredient_in_mixed_drink_name_is_filtered(self):
        for name in ["사과 캐모마일 블렌딩 티", "우유 캐모마일 블렌딩"]:
            mixed = {**details("chamomile", "hot")["variants"][0], "ingredient_names": [name]}
            self.assertFalse(suitable(mixed, "any", "any", ["캐모마일"]))

    def test_chamomile_exclusion_keeps_other_warm_caffeine_free_tea(self):
        rooibos = details("drink-744db51e0ad9", "hot")["variants"][0]
        self.assertTrue(suitable(rooibos, "none", "less", ["캐모마일"]))


if __name__ == "__main__": unittest.main()
