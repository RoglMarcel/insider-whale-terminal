import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('health', Path(__file__).resolve().parents[2] / 'scripts/publish-update-health.py')
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class UpdateHealthTests(unittest.TestCase):
    def test_process_failure_overrides_success_report_and_preserves_last_success(self):
        result = health.stage('failure', {'status': 'success', 'checkedAt': 'new'}, {'lastSuccessAt': 'old'})
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['lastSuccessAt'], 'old')

    def test_missing_report_is_not_success(self):
        self.assertEqual(health.stage('success', None, {})['status'], 'failed')

    def test_partial_does_not_advance_complete_timestamp(self):
        result = health.stage('success', {'status': 'partial', 'checkedAt': 'new'}, {'lastSuccessAt': 'old'})
        self.assertEqual(result['lastSuccessAt'], 'old')
        self.assertEqual(result['checkedAt'], 'new')

    def test_skipped_desktop_labeling_is_not_failure(self):
        result = health.stage('skipped', None, {'lastSuccessAt': 'old'})
        self.assertEqual(result['status'], 'skipped')
        self.assertEqual(result['lastSuccessAt'], 'old')

    def test_fresh_signals_do_not_disguise_old_portfolio(self):
        result = health.build({'status': 'success', 'generatedAt': 'new'}, {'meta': {'lastRun': 'old'}},
                             {'outcomes': {'status': 'success', 'checkedAt': 'new'}},
                             {'portfolio': 'failure', 'outcomes': 'success'},
                             {'portfolio': {'lastSuccessAt': 'older'}})
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['stages']['signals']['lastUpdatedAt'], 'new')
        self.assertEqual(result['stages']['portfolio']['lastUpdatedAt'], 'old')
        self.assertEqual(result['stages']['portfolio']['lastSuccessAt'], 'older')

    def test_missing_portfolio_cannot_be_healthy(self):
        report = {'status': 'success', 'checkedAt': 'new'}
        result = health.build({'status': 'success', 'generatedAt': 'new'}, None,
                             {'portfolio': report, 'outcomes': report},
                             {'portfolio': 'success', 'outcomes': 'success'}, {})
        self.assertEqual(result['stages']['portfolio']['status'], 'failed')
        self.assertIsNone(result['stages']['portfolio']['lastSuccessAt'])

    def test_complete_run_advances_each_timestamp(self):
        report = {'status': 'success', 'checkedAt': 'new'}
        result = health.build({'status': 'success', 'generatedAt': 'new'}, {'meta': {'lastRun': 'new'}},
                             {'portfolio': report, 'outcomes': report},
                             {'portfolio': 'success', 'outcomes': 'success'}, {})
        self.assertEqual(result['status'], 'success')
        self.assertTrue(all(s['lastSuccessAt'] == 'new' for s in result['stages'].values()))

    def test_publication_does_not_make_older_observations_fresh(self):
        report = {'status': 'success', 'checkedAt': 'new'}
        result = health.build({'status': 'partial', 'generatedAt': 'new', 'signalAsOf': 'old', 'source': 'desktop-publish-fastpath'},
                             {'meta': {'lastRun': 'old'}}, {'portfolio': report, 'outcomes': report},
                             {'portfolio': 'success', 'outcomes': 'success'}, {})
        self.assertEqual(result['stages']['signals']['lastUpdatedAt'], 'old')
        self.assertEqual(result['stages']['signals']['source'], 'desktop-publish-fastpath')
        self.assertEqual(result['stages']['signals']['status'], 'partial')


if __name__ == '__main__':
    unittest.main()
