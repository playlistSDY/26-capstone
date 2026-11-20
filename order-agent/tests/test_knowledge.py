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

    def test_decaf_is_not_reported_as_caffeine_free(self):
        decaf = details("americano", "ice", decaf=True)["variants"][0]
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


if __name__ == "__main__": unittest.main()
